import { google } from "googleapis";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function optionalEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return v;
}

function missing(names) {
  return names.filter((n) => !process.env[n]);
}

function normalizeFolderId(folderIdRaw) {
  const trimmed = folderIdRaw.trim();
  const withoutQuery = trimmed.split("?")[0];
  const m = withoutQuery.match(/\/folders\/([^/?]+)/);
  if (m?.[1]) return m[1];
  return withoutQuery;
}

function parseServiceAccountJson(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(decoded);
}

function parseRefreshToken(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

async function buildAuth() {
  const forced = (optionalEnv("DRIVE_AUTH_MODE") ?? "").toLowerCase();
  const refreshToken = optionalEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const anyOauth = Boolean(refreshToken || clientId || clientSecret);
  const allOauth = Boolean(refreshToken && clientId && clientSecret);

  if (forced === "oauth" && !allOauth) {
    throw new Error(
      `DRIVE_AUTH_MODE=oauth but missing env: ${missing([
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN"
      ]).join(", ")}`
    );
  }

  if (anyOauth && !allOauth) {
    throw new Error(
      `OAuth env partially set, missing: ${missing([
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN"
      ]).join(", ")}`
    );
  }

  if (allOauth) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: parseRefreshToken(refreshToken) });
    return { auth: oauth2, mode: "oauth" };
  }

  const sa = parseServiceAccountJson(requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.file"]
  });
  return { auth: jwt, mode: "service_account" };
}

async function main() {
  const folderId = normalizeFolderId(requireEnv("DRIVE_FOLDER_ID"));
  const { auth, mode } = await buildAuth();

  const drive = google.drive({ version: "v3", auth });

  const now = new Date();
  const name = `smoke-${now.toISOString().replaceAll(":", "-")}.txt`;
  const content =
    `AutoMeet Recorder Drive smoke test\n` +
    `createdAt=${now.toISOString()}\n` +
    `runner=${process.env.GITHUB_REPOSITORY ?? "local"}\n`;

  console.log(JSON.stringify({ authMode: mode, step: "upload_start" }));

  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
      mimeType: "text/plain"
    },
    media: {
      mimeType: "text/plain",
      body: content
    },
    fields: "id,name"
  });

  if (!res.data?.id) throw new Error("Drive upload failed (no file id returned)");
  console.log(JSON.stringify({ ok: true, authMode: mode, id: res.data.id, name: res.data.name }));
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});
