// One place to get a Google access token, for Search Console and Analytics alike.
//
// Service account keys are blocked by org policy on this Google Cloud project, so this is a user
// OAuth credential: a client id and secret plus a refresh token obtained once through a browser
// consent. Run scripts/google-authorize.mjs to mint one.
//
// Credentials are read, in order, from:
//   GOOGLE_CREDS            the JSON itself, for CI
//   GOOGLE_CREDS_FILE       a path to the JSON
//   ~/.vaeral-google.json   the default, so a local run needs no arguments
//
// Shape: {"client_id":…, "client_secret":…, "refresh_token":…}
//
// WATCH THE CONSENT SCREEN. While the OAuth app is in "Testing", Google expires its refresh
// tokens after SEVEN DAYS, which is what invalid_grant means here. Setting the app to Internal,
// or publishing it, is what makes the token last.
//
// Never commit the file. It holds a live refresh token.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CREDS = path.join(os.homedir(), '.vaeral-google.json');

export const SCOPES = {
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
};

export function loadCreds() {
  if (process.env.GOOGLE_CREDS) return JSON.parse(process.env.GOOGLE_CREDS);
  const file = process.env.GOOGLE_CREDS_FILE || DEFAULT_CREDS;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  throw new Error(
    `No Google credentials. Expected ${DEFAULT_CREDS} holding {client_id, client_secret, ` +
    'refresh_token}. Run: node scripts/google-authorize.mjs',
  );
}

export async function accessToken(scopes, creds = loadCreds()) {
  if (!creds.refresh_token) {
    throw new Error('credential has no refresh_token. Run: node scripts/google-authorize.mjs');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = `${json.error || ''} ${json.error_description || ''}`.trim();
    const hint = /invalid_grant/.test(detail)
      ? ' — the token was revoked, or the consent screen is still in Testing and its seven days are up'
      : '';
    throw new Error(`token exchange failed (${res.status}): ${detail}${hint}`);
  }
  // A refresh token only carries the scopes granted at consent. Say so plainly rather than
  // letting the caller hit an opaque 403 from the API itself.
  const granted = (json.scope || '').split(' ');
  const missing = (Array.isArray(scopes) ? scopes : [scopes]).filter((s) => !granted.includes(s));
  if (missing.length) {
    throw new Error(
      `the credential was not granted ${missing.join(', ')}. Re-run scripts/google-authorize.mjs ` +
      'to consent to both scopes.',
    );
  }
  return json.access_token;
}

// Says which credential is in play, without printing any secret.
export function describeCreds(creds = loadCreds()) {
  return {
    kind: 'user oauth',
    client: creds.client_id,
    hasRefreshToken: Boolean(creds.refresh_token),
    granted: creds.scopes || '(unknown until a token is fetched)',
  };
}
