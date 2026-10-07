// One place to get a Google access token, for Search Console and Analytics alike.
//
// Credentials are read, in order, from:
//   GOOGLE_CREDS            the JSON itself, for CI
//   GOOGLE_CREDS_FILE       a path to the JSON
//   ~/.vaeral-google.json   the default, so a local run needs no arguments
//
// Two shapes are accepted:
//   a service account key   {"type":"service_account","client_email":...,"private_key":...}
//   a user refresh token    {"client_id":...,"client_secret":...,"refresh_token":...}
//
// Prefer the service account. A refresh token issued by an app still in "Testing" on the OAuth
// consent screen EXPIRES AFTER SEVEN DAYS, which is the usual reason a working report suddenly
// starts returning invalid_grant. A service account key does not expire, and its scopes come
// from the grant it is given in each product rather than from a consent screen.
//
// Never commit the file. The website repo's .gitignore covers no credential pattern.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CREDS = path.join(os.homedir(), '.vaeral-google.json');

export function loadCreds() {
  if (process.env.GOOGLE_CREDS) return JSON.parse(process.env.GOOGLE_CREDS);
  const file = process.env.GOOGLE_CREDS_FILE || DEFAULT_CREDS;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  throw new Error(
    `No Google credentials. Put the JSON at ${DEFAULT_CREDS}, or set GOOGLE_CREDS_FILE, or ` +
    'GOOGLE_CREDS. Service account key, or {client_id, client_secret, refresh_token}.',
  );
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Service accounts authenticate by signing a JWT with their private key and exchanging it. No
// library needed; node's crypto signs RS256 directly.
async function serviceAccountToken(creds, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(
    crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), creds.private_key),
  );
  return exchange({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${header}.${claims}.${signature}`,
  });
}

function refreshTokenToken(creds) {
  return exchange({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  });
}

async function exchange(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // Say which failure it is. invalid_grant on a refresh token almost always means the consent
    // screen is still in Testing and the seven days are up.
    throw new Error(`token exchange failed (${res.status}): ${json.error || ''} ${json.error_description || ''}`.trim());
  }
  return json.access_token;
}

export async function accessToken(scopes, creds = loadCreds()) {
  const list = Array.isArray(scopes) ? scopes : [scopes];
  return creds.type === 'service_account'
    ? serviceAccountToken(creds, list)
    : refreshTokenToken(creds);
}

export const SCOPES = {
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
};

// Says which credential is in play and what it can reach, without printing any secret.
export function describeCreds(creds = loadCreds()) {
  return creds.type === 'service_account'
    ? { kind: 'service account', identity: creds.client_email, project: creds.project_id }
    : { kind: 'refresh token', identity: creds.client_id, project: null };
}
