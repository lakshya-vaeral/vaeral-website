// scripts/google-authorize.mjs — one-time browser consent, to mint the refresh token.
//
//   node scripts/google-authorize.mjs [--client <path to the OAuth client json>] [--port 3000]
//
// Defaults to ~/Downloads/vaeral-json-access.json, then ~/vaeral-json-access.json.
//
// FIRST, in the Cloud console, open the OAuth client and add this to Authorized redirect URIs:
//   http://localhost:3000/callback
// A web-application client refuses any redirect that is not registered, and the file ships with
// none, so without this the consent page returns redirect_uri_mismatch.
//
// Asks for Search Console and Analytics read scopes together, because a refresh token only
// carries what was granted at consent; consenting to one would make the other 403 later.
//
// Writes the finished credential to ~/.vaeral-google.json and prints nothing secret.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DEFAULT_CREDS, SCOPES } from './google-auth.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const PORT = Number(arg('--port', 3000));
const REDIRECT = `http://localhost:${PORT}/callback`;
const WANT = [SCOPES.searchConsole, SCOPES.analytics];

const candidates = [
  arg('--client', null),
  path.join(os.homedir(), 'Downloads', 'vaeral-json-access.json'),
  path.join(os.homedir(), 'vaeral-json-access.json'),
].filter(Boolean);

const clientFile = candidates.find((p) => fs.existsSync(p));
if (!clientFile) {
  console.error('No OAuth client file. Looked in:');
  candidates.forEach((p) => console.error('  ' + p));
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
const client = raw.web || raw.installed || raw;
if (!client.client_id || !client.client_secret) {
  console.error(`${clientFile} has no client_id/client_secret.`);
  process.exit(2);
}

const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: WANT.join(' '),
  access_type: 'offline',   // without this there is no refresh token at all
  prompt: 'consent',        // force one even if this account consented before
  include_granted_scopes: 'true',
});

console.log(`client : ${client.client_id}`);
console.log(`project: ${client.project_id || '(none in file)'}`);
console.log(`\nOpen this in a browser and approve, signed in as the account that can see`);
console.log('Search Console and Analytics for vaeral.com:\n');
console.log(consentUrl);
console.log(`\nWaiting on ${REDIRECT} ...`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const err = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<p>${err ? 'Denied: ' + err : 'Approved. You can close this tab.'}</p>`);
    server.close();
    err ? reject(new Error(err)) : resolve(got);
  });
  server.listen(PORT);
  server.on('error', reject);
  setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')); }, 300000);
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: client.client_id, client_secret: client.client_secret,
    redirect_uri: REDIRECT, grant_type: 'authorization_code',
  }),
});
const token = await res.json().catch(() => ({}));
if (!res.ok || !token.refresh_token) {
  console.error('token exchange failed:', token.error || res.status, token.error_description || '');
  if (!token.refresh_token && res.ok) {
    console.error('Google returned no refresh_token. Revoke this app at');
    console.error('https://myaccount.google.com/permissions and run this again.');
  }
  process.exit(1);
}

const granted = (token.scope || '').split(' ');
const missing = WANT.filter((s) => !granted.includes(s));

fs.writeFileSync(DEFAULT_CREDS, JSON.stringify({
  client_id: client.client_id,
  client_secret: client.client_secret,
  refresh_token: token.refresh_token,
  scopes: granted.filter((s) => WANT.includes(s)),
}, null, 2));
fs.chmodSync(DEFAULT_CREDS, 0o600);

console.log(`\nwrote ${DEFAULT_CREDS}`);
console.log('scopes granted:', granted.filter((s) => WANT.includes(s)).join(', ') || '(none of the two)');
if (missing.length) console.log('STILL MISSING:', missing.join(', '), '— re-run and tick both boxes.');
else console.log('\nNow run: npm run google:check');
