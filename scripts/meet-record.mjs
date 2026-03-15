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
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));

  const meetUrl = requireEnv("MEET_URL");
  const title = optionalEnv("SESSION_TITLE") ?? "Session";
  const durationMin = Number(optionalEnv("RECORD_MIN") ?? "10");
  const now = Date.now();
  return {
    id: optionalEnv("SESSION_ID") ?? `manual-${now}`,
    title,
    meetUrl,
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
    const clicked = await page.evaluate((texts) => {
      const targets = texts.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const b of buttons) {
        const txt = String(b.innerText ?? "").toLowerCase();
        for (const t of targets) {
          if (txt.includes(t)) {
            b.click();
            return true;
          }
        }
      }
      return false;
    }, texts);
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

async function enableCaptions(page) {
  const ok = await clickByAriaContains(page, ["captions", "caption"], { timeoutMs: 8_000 });
  if (ok) return;

  const openedMenu = await clickByAriaContains(page, ["More options"], { timeoutMs: 6_000 });
  if (!openedMenu) return;
  await clickByText(page, ["Turn on captions", "Captions"], { timeoutMs: 6_000 });
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
      "must be signed in",
      "not allowed to join",
      "ви не можете приєднатися",
      "увійдіть в обліковий запис google",
      "потрібно ввійти",
      "доступ заборонено"
    ];
    return markers.some((m) => t.includes(m));
  });
}

async function main() {
  const session = readSession();
  const titleSafe = sanitizeForPath(optionalEnv("SESSION_TITLE_SAFE") ?? session.title);

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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--lang=en-US",
      "--use-fake-ui-for-media-stream",
      "--mute-audio",
      "--window-size=1280,720"
    ]
  });

  let ffmpegProc = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(session.meetUrl, { waitUntil: "networkidle2" });

    await wait(1000);

    if (await detectAccessBlock(page)) {
      await dumpDebug(page, outDir, "access-block");
      throw new Error(
        "Meet denies guest access (requires invited signed-in account or host settings). Allow guests or invite the guest name, then retry."
      );
    }

    const nameInput =
      (await page.$('input[aria-label*="name" i]')) ??
      (await page.$('input[type="text"]'));

    if (nameInput) {
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(guestName, { delay: 15 });
    }

    await ensureMicCamOff(page);

    await clickByText(page, ["Continue without microphone and camera", "Continue"], { timeoutMs: 3_000 });

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

    try {
      await page.waitForNavigation({ timeout: 10_000, waitUntil: "domcontentloaded" });
    } catch {}

    const inCall = await waitForAriaButtonContains(
      page,
      ["leave call", "leave meeting", "hang up", "покин", "вийти", "заверш", "покинуть", "выйти", "завершить"],
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

    await page.exposeFunction("__onCaptionLine", (payload) => {
      const ts = typeof payload?.ts === "number" ? payload.ts : Date.now();
      const text = String(payload?.text ?? "").trim();
      if (!text) return;
      writeCaption(`${new Date(ts).toISOString()} ${text}`);
    });

    await page.evaluate(() => {
      const live =
        document.querySelector('[aria-live="polite"]') ??
        document.querySelector('[aria-live="assertive"]') ??
        document.body;

      const recent = [];
      const maxRecent = 200;

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
        const txt = live.textContent ?? "";
        const lines = txt
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6);
        for (const l of lines) emit(l);
      };

      scan();
      const obs = new MutationObserver(() => scan());
      obs.observe(live, { childList: true, subtree: true, characterData: true });
    });

    ffmpegProc = startFfmpeg({ display, videoSize, outFile: videoPath });

    const stopAt = Math.min(endMs, Date.now() + 6 * 60 * 60_000);
    while (Date.now() < stopAt) {
      await wait(1000);
      const leave = await page.$('button[aria-label*="leave call" i]');
      if (!leave) break;
    }
  } finally {
    await stopFfmpeg(ffmpegProc);
    captionsStream.end();
    await browser.close();
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
