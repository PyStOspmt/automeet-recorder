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

function parseRefreshToken(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty refresh token");
  return trimmed;
}

export async function getDriveClient() {
  const refreshToken = optionalEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const allOauth = Boolean(refreshToken && clientId && clientSecret);
  if (!allOauth) {
    throw new Error(
      `Missing OAuth env for Drive: ${[
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN"
      ]
        .filter((n) => !process.env[n])
        .join(", ")}`
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: parseRefreshToken(refreshToken) });
  const drive = google.drive({ version: "v3", auth });
  return drive;
}

export function normalizeFolderId(folderIdRaw) {
  const trimmed = folderIdRaw.trim();
  const withoutQuery = trimmed.split("?")[0];
  const m = withoutQuery.match(/\/folders\/([^/?]+)/);
  if (m?.[1]) return m[1];
  return withoutQuery;
}

export async function ensureFolder({ drive, parentId, name }) {
  const q =
    `name='${name.replaceAll("'", "\\'")}' and ` +
    `mimeType='application/vnd.google-apps.folder' and ` +
    `trashed=false and ` +
    `'${parentId}' in parents`;

  const list = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive"
  });

  const existing = list.data.files?.[0];
  if (existing?.id) return existing.id;

  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder"
    },
    fields: "id"
  });

  if (!created.data?.id) throw new Error("Failed to create folder");
  return created.data.id;
}

export async function uploadTextFile({ drive, parentId, name, content }) {
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "text/plain"
    },
    media: {
      mimeType: "text/plain",
      body: content
    },
    fields: "id,name"
  });

  if (!res.data?.id) throw new Error("Drive upload failed (no file id returned)");
  return { id: res.data.id, name: res.data.name };
}

export async function uploadBinaryFile({ drive, parentId, name, mimeType, filePath, fs }) {
  const stream = fs.createReadStream(filePath);
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType
    },
    media: {
      mimeType,
      body: stream
    },
    fields: "id,name"
  });

  if (!res.data?.id) throw new Error("Drive upload failed (no file id returned)");
  return { id: res.data.id, name: res.data.name };
}

export function getRootDriveFolderId() {
  return normalizeFolderId(requireEnv("DRIVE_FOLDER_ID"));
}

