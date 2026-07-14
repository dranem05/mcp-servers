import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type YouTubeAuth = InstanceType<typeof google.auth.OAuth2>;

interface CredentialsFile {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token?: string;
  token_uri?: string;
  scopes?: string[];
}

// Lazy: the credentials file may not exist yet when the server is first
// registered. The server starts regardless; tool calls surface the
// missing-token error with the fix.
export function loadAuth(slug: string, tokenDir: string): YouTubeAuth {
  const credPath = join(tokenDir, `youtube-${slug}-credentials.json`);

  let raw: string;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch {
    throw new Error(
      `Credentials file not found: ${credPath}\nCreate it per the "Authentication" section of the youtube-mcp README (OAuth client + refresh token with the youtube.readonly and yt-analytics.readonly scopes).`
    );
  }

  const creds: CredentialsFile = JSON.parse(raw);

  if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
    throw new Error(
      `Credentials file missing required fields (client_id, client_secret, refresh_token): ${credPath}`
    );
  }

  const client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  client.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.token || undefined,
  });

  return client;
}
