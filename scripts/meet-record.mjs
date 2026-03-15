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
  const micBtn = await page.$('button[aria-label*="microphone" i]');
  if (micBtn) {
    const label = (await micBtn.evaluate((n) => n.getAttribute("aria-label"))) ?? "";
    if (label.toLowerCase().includes("turn off")) await micBtn.click();
  }

  const camBtn = await page.$('button[aria-label*="camera" i]');
  if (camBtn) {
    const label = (await camBtn.evaluate((n) => n.getAttribute("aria-label"))) ?? "";
    if (label.toLowerCase().includes("turn off")) await camBtn.click();
  }
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
        if (label.includes('close') || label.includes('закрити') || label.includes('закрыть') || label.includes('dismiss')) {
          // Check if it's inside a toast or dialog or the top bar
          const isToast = btn.closest('[role="alert"], [data-is-toast="true"], .geSSfc, .jRlwIf, #google_translate_element');
          if (isToast) {
            btn.click();
          }
        }
      }
      
      // Explicitly try to close translate popup if standard X is found
      const translateClose = document.querySelector('.goog-te-banner-frame .goog-close-link');
      if (translateClose) translateClose.click();
    });
  } catch (e) {}
}
  await page.mouse.move(500, 500); // reveal control bar
  await wait(500);
  
  const ok = await clickByAriaContains(page, ["captions", "caption", "субтитр"], { timeoutMs: 8_000 });
  if (ok) return;

  const openedMenu = await clickByAriaContains(page, ["More options", "Інші параметри", "Другие параметры"], { timeoutMs: 6_000 });
  if (!openedMenu) return;
  await clickByText(page, ["Turn on captions", "Captions", "Увімкнути субтитри", "Субтитри", "Включить субтитры"], { timeoutMs: 6_000 });
}

async function setCaptionLanguageUkrainian(page) {
  try {
    await page.mouse.move(500, 500);
    await wait(500);
    
    // First try the quick on-screen dropdown if available
    const quickLangDropdown = await clickByText(page, ["Англійська", "English", "Английский"], { timeoutMs: 2000 });
    if (quickLangDropdown) {
      await wait(1000);
      await clickByText(page, ["Українська", "Ukrainian", "Украинский"], { timeoutMs: 2000 });
      return;
    }

    // Fallback to settings menu
    const openedMenu = await clickByAriaContains(page, ["More options", "Інші параметри", "Другие параметры"], { timeoutMs: 3000 });
    if (!openedMenu) return;
    await wait(500);
    const settings = await clickByText(page, ["Settings", "Налаштування", "Настройки"], { timeoutMs: 3000 });
    if (!settings) return;
    await wait(1000);
    await clickByText(page, ["Captions", "Субтитри", "Субтитры"], { timeoutMs: 3000 });
    await wait(1000);
    
    // Try to click current language dropdown (usually English by default)
    const clickedLang = await clickByText(page, ["English", "Англійська", "Английский"], { timeoutMs: 2000 });
    if (clickedLang) {
      await wait(1000);
      await clickByText(page, ["Ukrainian", "Українська", "Украинский"], { timeoutMs: 2000 });
      await wait(1000);
    }
    
    // Close settings (usually a button with 'Close' label)
    await clickByAriaContains(page, ["Close", "Закрити", "Закрыть"], { timeoutMs: 2000 });
  } catch (e) {
    console.error("Could not set caption language:", e.message);
  }
}

async function pinPresentation(page) {
  try {
    await page.evaluate(() => {
      // Look for buttons that say "Pin" or "Закріпити" and are related to presentations
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((label.includes('pin') || label.includes('закріпит')) && 
            (label.includes('presentation') || label.includes('презентац'))) {
          btn.click();
          break;
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

  fs.writeFileSync(metaPath, JSON.stringify({ id: session.id, title: session.title, start: session.start, end: session.end }), "utf8");

  const captionsStream = fs.createWriteStream(captionsPath, { flags: "a" });
  const writeCaption = (line) => captionsStream.write(line + "\n");

  const guestName = optionalEnv("MEET_GUEST_NAME") ?? "AutoMeet Recorder";
  const display = optionalEnv("DISPLAY") ?? ":99";
  const videoSize = optionalEnv("VIDEO_SIZE") ?? "1280x720";

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--lang=uk-UA,uk,en-US",
      "--use-fake-ui-for-media-stream",
      "--start-fullscreen",
      "--window-size=1280,720",
      "--disable-features=Translate",
      "--disable-translate",
      "--disable-infobars",
      "--disable-notifications"
    ]
  });

  let ffmpegProc = null;
  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      const style = document.createElement("style");
      style.textContent = `
        .skiptranslate, #google_translate_element { display: none !important; }
        body { top: 0 !important; }
        [data-is-toast="true"], [role="alert"], [role="alertdialog"], .geSSfc, .jRlwIf { 
          display: none !important; 
          opacity: 0 !important; 
          visibility: hidden !important; 
          pointer-events: none !important;
        }
      `;
      document.documentElement.appendChild(style);
      Object.defineProperty(navigator, 'language', { get: () => 'uk-UA' });
      Object.defineProperty(navigator, 'languages', { get: () => ['uk-UA', 'uk', 'en-US'] });
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

    await wait(1000);
    if (debugSteps) await dumpDebug(page, outDir, "01-loaded");

    if (await detectAccessBlock(page)) {
      await dumpDebug(page, outDir, "access-block");
      throw new Error(
        "Meet denies guest access (requires invited signed-in account or host settings). Allow guests or invite the guest name, then retry."
      );
    }

    const nameInput =
      (await page.$('input[aria-label*="name" i]')) ??
      (await page.$('input[placeholder*="name" i]')) ??
      (await page.$('input[type="text"]'));

    if (nameInput) {
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
        
        // Try specific caption classes first
        let foundSpecific = false;
        const captionNodes = document.querySelectorAll('.TBMuR, .a4cQT, .CNusmb, .iTTPOb');
        if (captionNodes.length > 0) {
          captionNodes.forEach(node => {
            // Find text nodes that look like captions
            const textContent = node.innerText || "";
            if (textContent && !exactIgnore.has(textContent.toLowerCase().trim())) {
               foundSpecific = true;
            }
            
            const speakerNode = node.querySelector('.zs7s8d, .jO7h3c');
            const speaker = speakerNode ? speakerNode.innerText.trim() : "";
            
            const textNodes = node.querySelectorAll('.iTTPOb');
            if (textNodes.length > 0) {
              textNodes.forEach(textNode => {
                const rawText = textNode.innerText || "";
                const validParts = rawText.split('\n')
                  .map(s => s.trim())
                  .filter(s => s.length > 0 && !exactIgnore.has(s.toLowerCase()) && !partialIgnore.some(p => s.toLowerCase().includes(p)));
                
                if (validParts.length > 0) {
                  lines.push(speaker ? `${speaker}: ${validParts.join(' ')}` : validParts.join(' '));
                }
              });
            } else {
               // If no specific text node inside, just use the parent's text
               const validParts = textContent.split('\n')
                  .map(s => s.trim())
                  .filter(s => s.length > 0 && !exactIgnore.has(s.toLowerCase()) && !partialIgnore.some(p => s.toLowerCase().includes(p)));
               if (validParts.length > 0 && !textContent.includes(speaker)) {
                  lines.push(speaker ? `${speaker}: ${validParts.join(' ')}` : validParts.join(' '));
               }
            }
          });
        }
        
        // Fallback to aria-live if no specific caption nodes found
        if (!foundSpecific) {
          const lives = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
          lives.forEach(live => {
             const rawText = live.innerText || "";
             const validParts = rawText.split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0 && !exactIgnore.has(s.toLowerCase()) && !partialIgnore.some(p => s.toLowerCase().includes(p)));
             lines.push(...validParts);
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
    let consecutiveMisses = 0;
    while (Date.now() < stopAt) {
      await clickCloseButtons(page);
      await pinPresentation(page);
      
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
