import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";
import { getDriveClient, getRootDriveFolderId, ensureFolder, uploadBinaryFile, uploadTextFile } from "./drive-client.mjs";

function optionalEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return v;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function sanitizeForPath(name) {
  return name
    .trim()
    .replaceAll(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replaceAll(/\s+/g, " ")
    .slice(0, 80);
}

function readSession() {
  const file = optionalEnv("SESSION_FILE");
  if (file) {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s?.meetUrl) {
      try {
        const u = new URL(String(s.meetUrl));
        const authuser = u.searchParams.get("authuser");
        u.search = "";
        if (authuser) u.searchParams.set("authuser", authuser);
        u.searchParams.set("hl", "uk");
        s.meetUrl = u.toString();
      } catch {}
    }
    return s;
  }

  const meetUrl = requireEnv("MEET_URL");
  const title = optionalEnv("SESSION_TITLE") ?? "Session";
  const durationMin = Number(optionalEnv("RECORD_MIN") ?? "10");
  const now = Date.now();
  let cleanMeetUrl = meetUrl;
  try {
    const u = new URL(meetUrl);
    const authuser = u.searchParams.get("authuser");
    u.search = "";
    if (authuser) u.searchParams.set("authuser", authuser);
    u.searchParams.set("hl", "uk");
    cleanMeetUrl = u.toString();
  } catch {}
  return {
    id: optionalEnv("SESSION_ID") ?? `manual-${now}`,
    title,
    meetUrl: cleanMeetUrl,
    start: new Date(now).toISOString(),
    end: new Date(now + durationMin * 60_000).toISOString()
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clickByText(page, texts, { timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let clicked = false;
    try {
      clicked = await page.evaluate((texts) => {
        const targets = texts.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
        const nodes = Array.from(document.querySelectorAll("button, a, [role='button'], [role='combobox'], [role='option'], [role='menuitem'], li"));
        for (const n of nodes) {
          const parts = [
            String(n.innerText ?? ""),
            String(n.textContent ?? ""),
            String(n.getAttribute?.("aria-label") ?? "")
          ];
          const txt = parts.join(" ").toLowerCase();
          for (const t of targets) {
            if (t && txt.includes(t)) {
              // @ts-ignore
              n.click();
              return true;
            }
          }
        }
        return false;
      }, texts);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Execution context was destroyed") || msg.includes("Cannot find context with specified id")) {
        await wait(250);
        continue;
      }
      throw e;
    }
    if (clicked) return true;
    await wait(250);
  }
  return false;
}

async function clickByAriaContains(page, fragments, { timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const f of fragments) {
      const el = await page.$(`button[aria-label*="${f}" i]`);
      if (el) {
        await el.click();
        return true;
      }
    }
    await wait(250);
  }
  return false;
}

async function waitForAriaButtonContains(page, fragments, { timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let found = false;
    try {
      found = await page.evaluate((fragments) => {
        const frags = fragments.map((f) => String(f).toLowerCase());
        const btns = Array.from(document.querySelectorAll("button"));
        for (const b of btns) {
          const label = String(b.getAttribute("aria-label") ?? "").toLowerCase();
          if (!label) continue;
          for (const f of frags) {
            if (label.includes(f)) return true;
          }
        }
        return false;
      }, fragments);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("Execution context was destroyed") ||
        msg.includes("Cannot find context with specified id") ||
        msg.includes("Target closed")
      ) {
        await wait(250);
        continue;
      }
      throw e;
    }
    if (found) return true;
    await wait(250);
  }
  return false;
}

async function ensureMicCamOff(page) {
  await muteMicAndCamera(page);
}

function startFfmpeg({ display, videoSize, outFile }) {
  const args = [
    "-y",
    "-loglevel",
    "warning",
    "-f",
    "pulse",
    "-i",
    "default",
    "-f",
    "x11grab",
    "-video_size",
    videoSize,
    "-framerate",
    "25",
    "-i",
    display,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    outFile
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
  return proc;
}

async function stopFfmpeg(proc) {
  if (!proc || proc.killed) return;
  await new Promise((resolve) => {
    proc.once("close", resolve);
    proc.kill("SIGINT");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 10_000);
  });
}

async function clickCloseButtons(page) {
  try {
    await page.evaluate(() => {
      const closeButtons = Array.from(document.querySelectorAll('button'));
      for (const btn of closeButtons) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        // Look for close buttons on toasts and translate UI
        if (label.includes('close') || label.includes('закрити') || label.includes('закрыть') || label.includes('dismiss') || label.includes('скасувати') || label.includes('cancel')) {
          // Check if it's inside a toast or dialog or the top bar
          const isToast = btn.closest('[role="alert"], [data-is-toast="true"], .geSSfc, .jRlwIf, #google_translate_element, [role="dialog"]');
          if (isToast) {
            btn.click();
          }
        }
      }

      // Explicitly find and dismiss specifically "Мікрофон не знайдено" and similar alerts by clicking their X button
      const allBtns = Array.from(document.querySelectorAll('button'));
      for (const btn of allBtns) {
        if (btn.querySelector('svg')) { // Often close buttons are just SVGs inside a button
           const alertParent = btn.closest('[role="alert"], [role="dialog"], .geSSfc');
           const alertText = String(alertParent?.textContent || '').toLowerCase();
           if (alertParent && (alertText.includes('мікрофон') || alertText.includes('microphone') || alertText.includes('камеру не знайдено') || alertText.includes('camera not found') || alertText.includes('камера не найдена'))) {
             btn.click();
           }
        }
      }

      const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], [data-is-toast="true"], .geSSfc, .jRlwIf'));
      for (const alert of alerts) {
        const text = String(alert.textContent || '').toLowerCase();
        if (!text) continue;
        if (text.includes('камеру не знайдено') || text.includes('camera not found') || text.includes('камера не найдена') || text.includes('мікрофон') || text.includes('микрофон') || text.includes('microphone')) {
          const closeBtn = alert.querySelector('button, [role="button"]');
          if (closeBtn) {
            closeBtn.click();
          } else {
            alert.remove();
          }
        }
      }
      
      // Dismiss unwanted dialogs like "Mute all users?" by clicking Cancel
      const dialogBtns = Array.from(document.querySelectorAll('[role="dialog"] button, .geSSfc button'));
      for (const btn of dialogBtns) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (text === 'скасувати' || text === 'cancel' || text === 'отмена') {
          btn.click();
        }
      }
      
      // Explicitly try to close translate popup if standard X is found
      const translateClose = document.querySelector('.goog-te-banner-frame .goog-close-link');
      if (translateClose) translateClose.click();
    });
  } catch (e) {}
}
async function enableCaptions(page) {
  await page.mouse.move(500, 500); // reveal control bar
  await wait(500);
  
  const ok = await clickByAriaContains(page, ["captions", "caption", "субтитр"], { timeoutMs: 8_000 });
  if (ok) return;

  const openedMenu = await clickByAriaContains(page, ["More options", "Інші параметри", "Другие параметры"], { timeoutMs: 6_000 });
  if (!openedMenu) return;
  await clickByText(page, ["Turn on captions", "Captions", "Увімкнути субтитри", "Субтитри", "Включить субтитры"], { timeoutMs: 6_000 });
}

async function muteMicAndCamera(page) {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const micBtn = btns.find(b => {
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        if (l.includes('користувач') || l.includes('всіх') || l.includes('everyone') || l.includes('all')) return false;
        return l.includes('вимкнути мікрофон') || l.includes('turn off microphone') || l.includes('отключить микрофон');
      });
      if (micBtn) micBtn.click();
      
      const camBtn = btns.find(b => {
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        if (l.includes('користувач') || l.includes('всіх') || l.includes('everyone') || l.includes('all')) return false;
        return l.includes('вимкнути камеру') || l.includes('turn off camera') || l.includes('отключить камеру');
      });
      if (camBtn) camBtn.click();
    });
  } catch (e) {}
}

async function setCaptionLanguageUkrainian(page) {
  try {
    await page.mouse.move(500, 500);
    await wait(500);
    
    // First try the quick on-screen dropdown if available
    const changedQuick = await page.evaluate(async () => {
      const getText = (el) => (el?.innerText || el?.textContent || "").trim().toLowerCase();
      const languageTexts = ["англійська", "english", "английский", "українська", "ukrainian", "украинский"];
      const clickableNodes = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      const dropdown = clickableNodes.find(node => {
        const text = getText(node);
        return text.length < 50 && languageTexts.some(lt => text.includes(lt));
      });

      if (!dropdown) return false;

      dropdown.click();
      await new Promise(r => setTimeout(r, 1200));

      const optionNodes = Array.from(document.querySelectorAll('li, [role="option"], button, [role="button"], div, span'));
      const ukOption = optionNodes.find(node => {
        const text = getText(node);
        return text.length < 50 && (text.includes("українська") || text.includes("ukrainian") || text.includes("украинский"));
      });

      ukOption.click();
      await new Promise(r => setTimeout(r, 1200));

      const afterNodes = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      return afterNodes.some(node => {
        const text = getText(node);
        return text.length < 50 && (text.includes("українська") || text.includes("ukrainian") || text.includes("украинский"));
      });
    });
    
    if (changedQuick) return;

    // Fallback to settings menu
    const openedMenu = await clickByAriaContains(page, ["More options", "Інші параметри", "Другие параметры"], { timeoutMs: 3000 });
    if (!openedMenu) return;
    await wait(500);
    const settings = await clickByText(page, ["Settings", "Налаштування", "Настройки"], { timeoutMs: 3000 });
    if (!settings) return;
    await wait(1000);
    await clickByText(page, ["Captions", "Субтитри", "Субтитры"], { timeoutMs: 3000 });
    await wait(1000);
    
    const changedInSettings = await page.evaluate(async () => {
      const getText = (el) => (el?.innerText || el?.textContent || "").trim().toLowerCase();
      const dropdownNodes = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      const currentLang = dropdownNodes.find(node => {
        const text = getText(node);
        return text.length < 50 && (text.includes("англійська") || text.includes("english") || text.includes("английский") || text.includes("українська") || text.includes("ukrainian") || text.includes("украинский"));
      });

      if (!currentLang) return false;

      currentLang.click();
      await new Promise(r => setTimeout(r, 1200));

      const optionNodes = Array.from(document.querySelectorAll('li, [role="option"], button, [role="button"], div, span'));
      const ukOption = optionNodes.find(node => {
        const text = getText(node);
        return text.length < 50 && (text.includes("українська") || text.includes("ukrainian") || text.includes("украинский"));
      });

      ukOption.click();
      await new Promise(r => setTimeout(r, 1200));

      const afterNodes = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      return afterNodes.some(node => {
        const text = getText(node);
        return text.length < 50 && (text.includes("українська") || text.includes("ukrainian") || text.includes("украинский"));
      });
    });
    await wait(1000);
    
    // Close settings
    await clickByAriaContains(page, ["Close", "Закрити", "Закрыть"], { timeoutMs: 2000 });

    if (!changedInSettings) {
      console.error("Could not confirm Ukrainian captions after settings change.");
    }
  } catch (e) {
    console.error("Could not set caption language:", e.message);
  }
}

async function isCaptionLanguageUkrainian(page) {
  try {
    return await page.evaluate(() => {
      const getText = (el) => (el?.innerText || el?.textContent || "").trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      return nodes.some(node => {
        const text = getText(node);
        return text.length < 50 && (text.includes("українська") || text.includes("ukrainian") || text.includes("украинский"));
      });
    });
  } catch {
    return false;
  }
}

async function setLayoutSpotlight(page) {
  try {
    await page.mouse.move(500, 500);
    await wait(500);
    
    const openedMenu = await clickByAriaContains(page, ["More options", "Інші параметри", "Другие параметры"], { timeoutMs: 3000 });
    if (!openedMenu) return;
    await wait(500);
    
    const layout = await clickByText(page, ["Change layout", "Змінити макет", "Изменить макет"], { timeoutMs: 3000 });
    if (!layout) return;
    await wait(1000);
    
    await clickByText(page, ["Spotlight", "У центрі уваги", "В центре внимания"], { timeoutMs: 3000 });
    await wait(1000);
    
    await clickByAriaContains(page, ["Close", "Закрити", "Закрыть"], { timeoutMs: 2000 });
  } catch (e) {}
}

async function pinPresentation(page) {
  try {
    await page.evaluate(() => {
      // Look for buttons that say "Pin" or "Закріпити" and are related to presentations
      // Or just find the presentation tile and click its pin button
      const allTiles = Array.from(document.querySelectorAll('[data-requested-participant-id]'));
      for (const tile of allTiles) {
        const text = (tile.innerText || '').toLowerCase();
        if (text.includes('презентація') || text.includes('presentation') || text.includes('презентация')) {
          const pinBtn = tile.querySelector('button[aria-label*="Закріпит" i], button[aria-label*="Pin" i], button[aria-label*="закріпит" i], button[aria-label*="pin" i]');
          if (pinBtn) {
            const label = (pinBtn.getAttribute('aria-label') || '').toLowerCase();
            if (!label.includes('unpin') && !label.includes('відкріпит') && !label.includes('открепит')) {
              pinBtn.click();
            }
          } else {
            // Fallback: double click the tile
            tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
          }
        }
      }
    });
  } catch (e) {}
}

async function dumpDebug(page, outDir, tag) {
  try {
    const safe = tag.replaceAll(/[^a-zA-Z0-9_-]+/g, "_");
    await page.screenshot({ path: path.join(outDir, `debug-${safe}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(outDir, `debug-${safe}.html`), html, "utf8");
  } catch {}
}

async function detectAccessBlock(page) {
  return page.evaluate(() => {
    const t = (document.body?.innerText ?? "").toLowerCase();
    const markers = [
      "you can't join this meeting",
      "can’t join this meeting",
      "ask your host",
      "sign in with the google account your host invited",
      "instead of waiting to be let in, sign in",
      "sign in with your google account",
      "must be signed in",
      "not allowed to join",
      "ви не можете приєднатися",
      "увійдіть в обліковий запис google",
      "увійдіть в обліковий запис google, який запросив вас організатор",
      "потрібно ввійти",
      "доступ заборонено"
    ];
    return markers.some((m) => t.includes(m));
  });
}

async function main() {
  const session = readSession();
  const titleSafe = sanitizeForPath(optionalEnv("SESSION_TITLE_SAFE") ?? session.title);
  const skipRecording = optionalEnv("SKIP_RECORDING") === "1";
  const skipUpload = optionalEnv("SKIP_UPLOAD") === "1";
  const debugSteps = optionalEnv("DEBUG_STEPS") === "1";

  const startMs = Date.parse(session.start);
  const endMs = Date.parse(session.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) throw new Error("Invalid session times");

  const outDir = path.join(process.cwd(), "out", `${session.id}-${titleSafe}`);
  fs.mkdirSync(outDir, { recursive: true });
  const videoPath = path.join(outDir, "recording.mp4");
  const captionsPath = path.join(outDir, "captions.txt");
  const metaPath = path.join(outDir, "meta.json");
  const chromeProfileDir = path.join(outDir, "chrome-profile");
  const chromeDefaultDir = path.join(chromeProfileDir, "Default");

  fs.mkdirSync(chromeDefaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(chromeDefaultDir, "Preferences"),
    JSON.stringify({
      translate: { enabled: false },
      intl: { accept_languages: "uk-UA,uk,en-US,en" },
      profile: { default_content_setting_values: { notifications: 2 } }
    }),
    "utf8"
  );

  fs.writeFileSync(metaPath, JSON.stringify({ id: session.id, title: session.title, start: session.start, end: session.end }), "utf8");

  const captionsStream = fs.createWriteStream(captionsPath, { flags: "a" });
  const writeCaption = (line) => captionsStream.write(line + "\n");

  const guestName = optionalEnv("MEET_GUEST_NAME") ?? "AutoMeet Recorder";
  const display = optionalEnv("DISPLAY") ?? ":99";
  const videoSize = optionalEnv("VIDEO_SIZE") ?? "1280x720";

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: chromeProfileDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--lang=uk-UA,uk,en-US",
      "--use-fake-ui-for-media-stream",
      "--start-fullscreen",
      "--window-size=1280,720",
      "--disable-features=Translate,TranslateUI,TranslateSubFrames,OptimizationGuideModelDownloading",
      "--blink-settings=translateEnabled=false",
      "--disable-translate",
      "--disable-infobars",
      "--disable-notifications"
    ]
  });

  let ffmpegProc = null;
  try {
    const page = await browser.newPage();
    const context = browser.defaultBrowserContext();
    await context.overridePermissions("https://meet.google.com", ["microphone", "camera", "notifications"]);
    await page.setExtraHTTPHeaders({ "Accept-Language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7" });
    
    // Completely block native Chrome Translate popup by declaring the page as our native language immediately
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'language', {get: () => 'uk-UA'});
      Object.defineProperty(navigator, 'languages', {get: () => ['uk-UA', 'uk', 'en']});
      // Also inject the meta tag early
      const meta = document.createElement('meta');
      meta.name = 'google';
      meta.content = 'notranslate';
      document.head.appendChild(meta);
      document.documentElement.setAttribute('translate', 'no');
      document.body?.setAttribute?.('translate', 'no');

      const cleanupTranslateUi = () => {
        const selectors = [
          '.skiptranslate',
          '#google_translate_element',
          '.goog-te-banner-frame',
          '.goog-te-balloon-frame',
          '.goog-te-menu-frame',
          '[class*="goog-te"]',
          '[id*="goog-gt"]',
          'iframe[src*="translate"]',
          'iframe[name*="translate"]'
        ];

        for (const selector of selectors) {
          document.querySelectorAll(selector).forEach(node => node.remove());
        }
      };
      
      if (window.location.hostname.includes("meet.google.com")) {
        const style = document.createElement("style");
        style.textContent = `
          .skiptranslate, #google_translate_element { display: none !important; }
          body { top: 0 !important; }
          .goog-te-banner-frame, .goog-te-balloon-frame, .goog-te-menu-frame, [class*="goog-te"], [id*="goog-gt"], iframe[src*="translate"], iframe[name*="translate"] {
            display: none !important;
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
          [data-is-toast="true"], [role="alert"], [role="alertdialog"], .geSSfc, .jRlwIf { 
            display: none !important; 
            opacity: 0 !important; 
            visibility: hidden !important; 
            pointer-events: none !important;
          }
        `;
        document.documentElement.appendChild(style);
        cleanupTranslateUi();
        setInterval(cleanupTranslateUi, 500);
      }
    });

    const cookiesEnv = optionalEnv("MEET_ACCOUNT_COOKIES");
    if (cookiesEnv) {
      try {
        const cookies = JSON.parse(cookiesEnv);
        await page.setCookie(...cookies);
        console.log("Injected Google account cookies.");
      } catch (err) {
        console.error("Failed to parse or set MEET_ACCOUNT_COOKIES:", err.message);
      }
    }

    await page.goto(session.meetUrl, { waitUntil: "networkidle2" });

    // Inject strong CSS after load and set translate=no
    await page.addStyleTag({
      content: `
        .skiptranslate, #google_translate_element { display: none !important; }
        [data-is-toast="true"], [role="alert"], [role="alertdialog"], .geSSfc, .jRlwIf, .g3ZIue { 
          display: none !important; 
          opacity: 0 !important; 
          visibility: hidden !important; 
          pointer-events: none !important;
        }
      `
    });
    await page.evaluate(() => document.documentElement.setAttribute("translate", "no"));

    await wait(3000); // Give it a bit more time to process redirects / auth
    if (debugSteps) await dumpDebug(page, outDir, "01-loaded");

    if (await detectAccessBlock(page)) {
      // Sometimes page says "please wait" before admitting, or auth is slow
      await wait(3000);
      if (await detectAccessBlock(page)) {
        await dumpDebug(page, outDir, "access-block");
        throw new Error(
          "Meet denies guest access (requires invited signed-in account or host settings). Allow guests or invite the guest name, then retry."
        );
      }
    }

    const nameInput =
      (await page.$('input[aria-label*="name" i]')) ??
      (await page.$('input[placeholder*="name" i]')) ??
      (await page.$('input[type="text"]'));

    if (nameInput) {
      await muteMicAndCamera(page); // Mute early in waiting room
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(guestName, { delay: 15 });
      try {
        await page.keyboard.press("Enter");
      } catch {}
    }
    if (debugSteps) await dumpDebug(page, outDir, "02-name");

    await ensureMicCamOff(page);
    if (debugSteps) await dumpDebug(page, outDir, "03-miccam");

    await clickByText(
      page,
      [
        "Continue without microphone and camera",
        "Continue without microphone & camera",
        "Continue without microphone",
        "Continue",
        "Продовжити без мікрофона й камери",
        "Продовжити без мікрофона та камери",
        "Продовжити",
        "Продолжить без микрофона и камеры",
        "Продолжить"
      ],
      { timeoutMs: 6_000 }
    );
    await wait(500);
    if (debugSteps) await dumpDebug(page, outDir, "04-continue");

    await clickByText(
      page,
      [
        "Ask to join",
        "Join now",
        "Попросити приєднатися",
        "Приєднатися",
        "Приєднатися зараз",
        "Попросить присоединиться",
        "Присоединиться",
        "Присоединиться сейчас"
      ],
      { timeoutMs: 20_000 }
    );
    if (debugSteps) await dumpDebug(page, outDir, "05-joinclick");

    try {
      await page.waitForNavigation({ timeout: 10_000, waitUntil: "domcontentloaded" });
    } catch {}

    await clickByText(page, ["Got it", "OK", "Okay", "Зрозуміло", "Гаразд", "Добре", "Понятно"], { timeoutMs: 3_000 });
    if (debugSteps) await dumpDebug(page, outDir, "06-postjoin");

    const inCall = await waitForAriaButtonContains(
      page,
      ["leave call", "leave meeting", "hang up", "покин", "покинути", "вийти", "заверш", "покинуть", "выйти", "завершить"],
      { timeoutMs: 90_000 }
    );

    if (!inCall) {
      await dumpDebug(page, outDir, "join-timeout");
      if (await detectAccessBlock(page)) {
        throw new Error(
          "Meet denies guest access (requires invited signed-in account or host settings). Allow guests or invite the guest name, then retry."
        );
      }
      throw new Error("Timeout waiting to enter the call (not admitted or UI changed).");
    }

    await enableCaptions(page);
    await setCaptionLanguageUkrainian(page);
    if (!(await isCaptionLanguageUkrainian(page))) {
      await wait(1500);
      await setCaptionLanguageUkrainian(page);
    }

    await page.exposeFunction("__onCaptionLine", (payload) => {
      const ts = typeof payload?.ts === "number" ? payload.ts : Date.now();
      const text = String(payload?.text ?? "").trim();
      if (!text) return;
      writeCaption(`${new Date(ts).toISOString()} ${text}`);
    });

    await page.evaluate(() => {
      const recent = [];
      const maxRecent = 500;

      const exactIgnore = new Set([
        "language", "англійська", "английский", "english", "українська", "украинский", "ukrainian",
        "format_size", "розмір шрифту", "размер шрифта", "font size",
        "circle", "колір шрифту", "цвет шрифта", "font color",
        "settings", "відкрити налаштування субтитрів", "открыть настройки субтитров", "caption settings",
        "close", "закрити", "закрыть"
      ]);

      const partialIgnore = [
        "залишилося", "повернення", "вилучили", "додано на головний", 
        "оцініть якість", "has left", "has joined", "presentation", "is presenting",
        "долучився", "залишив", "приєднався", "секунд", "покинув", "покинула"
      ];

      const emit = (text) => {
        const t = String(text ?? "").replaceAll("\u00A0", " ").trim();
        if (!t) return;
        
        const key = t;
        if (recent.includes(key)) return;
        recent.push(key);
        if (recent.length > maxRecent) recent.shift();
        
        // @ts-ignore
        window.__onCaptionLine({ ts: Date.now(), text: t });
      };

      const scan = () => {
        const lines = [];
        
        let foundSpecific = false;
        // Search specific subtitle classes ONLY to avoid grabbing UI elements
        const textNodes = document.querySelectorAll('.iTTPOb, .CNusmb .a4cQT');
        
        if (textNodes.length > 0) {
          textNodes.forEach(node => {
            const rawText = node.textContent || node.innerText || "";
            const validParts = rawText.split('\n')
              .map(s => s.trim())
              .filter(s => s.length > 0 && !exactIgnore.has(s.toLowerCase()) && !partialIgnore.some(p => s.toLowerCase().includes(p)));
            
            if (validParts.length > 0) {
              foundSpecific = true;
              lines.push(validParts.join(' '));
            }
          });
        }
        
        // Fallback to aria-live if no specific caption nodes found
        if (!foundSpecific) {
          const lives = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
          lives.forEach(live => {
             const rawText = live.textContent || live.innerText || "";
             // Only process if it doesn't look like a giant UI dump
             if (rawText.length < 500) {
               const validParts = rawText.split('\n')
                  .map(s => s.trim())
                  .filter(s => s.length > 0 && !exactIgnore.has(s.toLowerCase()) && !partialIgnore.some(p => s.toLowerCase().includes(p)));
               lines.push(...validParts);
             }
          });
        }

        // Final filter just in case
        lines
          .map(l => l.trim())
          .filter(l => l.length > 0 && !exactIgnore.has(l.toLowerCase()) && !partialIgnore.some(p => l.toLowerCase().includes(p)))
          .forEach(l => emit(l));
      };

      scan();
      const obs = new MutationObserver(() => scan());
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    if (!skipRecording) {
      ffmpegProc = startFfmpeg({ display, videoSize, outFile: videoPath });
    }

    const stopAt = Math.min(endMs, Date.now() + 6 * 60 * 60_000);
    let layoutChanged = false;
    let consecutiveMisses = 0;
    
    await muteMicAndCamera(page); // Make sure we are muted after joining to stop fake device beep

    while (Date.now() < stopAt) {
      await clickCloseButtons(page);

      if (!(await isCaptionLanguageUkrainian(page))) {
        await setCaptionLanguageUkrainian(page);
      }

      await pinPresentation(page);
      
      // Try to change layout to spotlight once per call, doing it during the loop ensures we're fully in
      if (!layoutChanged) {
        await setLayoutSpotlight(page);
        layoutChanged = true;
      }
      
      await wait(2000);
      const stillInCall = await page.evaluate(() => {
        const frags = ["leave call", "leave meeting", "hang up", "покин", "вийти", "заверш", "покинуть", "выйти"];
        const btns = Array.from(document.querySelectorAll("button"));
        for (const b of btns) {
          const label = String(b.getAttribute("aria-label") ?? "").toLowerCase();
          if (label && frags.some(f => label.includes(f))) return true;
        }
        return false;
      });
      
      if (!stillInCall) {
        consecutiveMisses++;
        if (consecutiveMisses > 3) break; // Break only if button is missing for 3 checks (6+ seconds) to avoid DOM refresh issues
      } else {
        consecutiveMisses = 0;
      }
    }
  } finally {
    await stopFfmpeg(ffmpegProc);
    captionsStream.end();
    await browser.close();
  }

  if (skipUpload) {
    console.log(JSON.stringify({ ok: true, skippedUpload: true, outDir }));
    return;
  }

  const drive = await getDriveClient();
  const rootId = getRootDriveFolderId();
  const day = new Date(startMs).toISOString().slice(0, 10);
  const dayFolderId = await ensureFolder({ drive, parentId: rootId, name: day });
  const sessionFolderId = await ensureFolder({ drive, parentId: dayFolderId, name: `${titleSafe}-${session.id}` });

  await uploadBinaryFile({ drive, parentId: sessionFolderId, name: "recording.mp4", mimeType: "video/mp4", filePath: videoPath, fs });
  await uploadBinaryFile({ drive, parentId: sessionFolderId, name: "meta.json", mimeType: "application/json", filePath: metaPath, fs });
  await uploadTextFile({ drive, parentId: sessionFolderId, name: "captions.txt", content: fs.readFileSync(captionsPath, "utf8") });

  console.log(JSON.stringify({ ok: true, id: session.id, title: session.title }));
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});
