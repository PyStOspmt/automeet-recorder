import fs from "node:fs";
import { getDriveClient, getRootDriveFolderId, ensureFolder, uploadTextFile } from "./drive-client.mjs";

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

function parseJsonEnv(name) {
  const raw = requireEnv(name).trim();
  if (raw.startsWith("{") || raw.startsWith("[")) return JSON.parse(raw);
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(decoded);
}

function toMs(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid ISO datetime: ${iso}`);
  return t;
}

function sanitizeForPath(name) {
  return name
    .trim()
    .replaceAll(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replaceAll(/\s+/g, " ")
    .slice(0, 80);
}

async function hasLock({ drive, locksFolderId, lockName }) {
  const q = `name='${lockName.replaceAll("'", "\\'")}' and trashed=false and '${locksFolderId}' in parents`;
  const res = await drive.files.list({ q, fields: "files(id,name)", spaces: "drive" });
  return Boolean(res.data.files?.[0]?.id);
}

async function createLock({ drive, locksFolderId, lockName }) {
  await uploadTextFile({ drive, parentId: locksFolderId, name: lockName, content: new Date().toISOString() });
}

async function main() {
  const schedule = parseJsonEnv("SCHEDULE_JSON");
  const graceMin = Number(optionalEnv("SCHEDULE_GRACE_MIN") ?? "3");
  const now = Date.now();
  const graceMs = graceMin * 60_000;

  const sessions = Array.isArray(schedule?.sessions) ? schedule.sessions : Array.isArray(schedule) ? schedule : [];
  if (!sessions.length) throw new Error("No sessions in SCHEDULE_JSON");

  const candidates = sessions
    .map((s) => ({
      id: String(s.id ?? ""),
      title: String(s.title ?? "Session"),
      meetUrl: String(s.meetUrl ?? ""),
      startMs: toMs(String(s.start)),
      endMs: toMs(String(s.end))
    }))
    .filter((s) => s.id && s.meetUrl && s.endMs > s.startMs)
    .filter((s) => now >= s.startMs - graceMs && now <= s.endMs - 30_000)
    .sort((a, b) => a.startMs - b.startMs);

  if (!candidates.length) {
    console.log(JSON.stringify({ ok: true, action: "none", now: new Date(now).toISOString() }));
    return;
  }

  const selected = candidates[0];
  const dryRun = optionalEnv("DRY_RUN") === "1";

  const drive = await getDriveClient();
  const rootId = getRootDriveFolderId();
  const locksFolderId = await ensureFolder({ drive, parentId: rootId, name: "locks" });
  const lockName = `lock-${selected.id}.txt`;

  if (await hasLock({ drive, locksFolderId, lockName })) {
    console.log(JSON.stringify({ ok: true, action: "locked", id: selected.id }));
    return;
  }

  await createLock({ drive, locksFolderId, lockName });

  const outTitle = sanitizeForPath(selected.title);
  const payload = {
    id: selected.id,
    title: selected.title,
    meetUrl: selected.meetUrl,
    start: new Date(selected.startMs).toISOString(),
    end: new Date(selected.endMs).toISOString()
  };

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, action: "dry_run", session: { id: selected.id, title: selected.title } }));
    return;
  }

  fs.writeFileSync("session.json", JSON.stringify(payload), "utf8");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("node", ["./scripts/meet-record.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      SESSION_FILE: "session.json",
      SESSION_TITLE_SAFE: outTitle
    }
  });

  if (result.status !== 0) {
    throw new Error(`meet-record failed with exit code ${result.status}`);
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});

