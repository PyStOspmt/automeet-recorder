import http from "node:http";
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

function getRedirectUri() {
  const explicit = optionalEnv("GOOGLE_OAUTH_REDIRECT_URI");
  if (explicit) return explicit;

  const portRaw = optionalEnv("GOOGLE_OAUTH_REDIRECT_PORT") ?? "53682";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid GOOGLE_OAUTH_REDIRECT_PORT: ${portRaw}`);
  }
  return `http://127.0.0.1:${port}/oauth2callback`;
}

async function main() {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const redirectUri = getRedirectUri();
  const redirectUrl = new URL(redirectUri);
  if (redirectUrl.protocol !== "http:") throw new Error("Redirect URI must be http:// for loopback");
  if (redirectUrl.hostname !== "127.0.0.1") throw new Error("Redirect URI host must be 127.0.0.1");

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirectUrl.port), "127.0.0.1", resolve);
  });

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const scopes = ["https://www.googleapis.com/auth/drive.file"];
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
  });

  console.log("Open this URL in your browser:");
  console.log(authUrl);

  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for OAuth callback")), 5 * 60_000);
    server.on("request", (req, res) => {
      try {
        const url = new URL(req.url ?? "", redirectUri);
        if (url.pathname !== "/oauth2callback") return;
        const code = url.searchParams.get("code");
        if (!code) throw new Error("Missing code in callback");
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("OK. You can close this tab and return to the terminal.");
        clearTimeout(timeout);
        resolve(code);
      } catch (e) {
        res.statusCode = 500;
        res.end("OAuth error");
        clearTimeout(timeout);
        reject(e);
      }
    });
  });

  server.close();

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error("No refresh_token returned. Ensure prompt=consent and access_type=offline.");

  console.log(JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});
