// scripts/check-cms-auth.mjs — the CMS sign-in hands out a repo-write GitHub token, so check
// who gets it. Runs api/auth.js and api/callback.js with Google faked out; no network.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import auth from '../api/auth.js';
import callback from '../api/callback.js';

const salt = crypto.randomBytes(16).toString('hex');
Object.assign(process.env, {
  OAUTH_GOOGLE_CLIENT_ID: 'cid', OAUTH_GOOGLE_CLIENT_SECRET: 'sec', CMS_GITHUB_TOKEN: 'GH-TOKEN',
  CMS_USERS: JSON.stringify({ gajanand: `${salt}:${crypto.scryptSync('right-pass', salt, 64).toString('hex')}` }),
});
const headers = { host: 'www.vaeral.com', 'x-forwarded-proto': 'https', cookie: 'decap_oauth_state=s1' };

function run(handler, url, { googleReply, method = 'GET', body } = {}) {
  globalThis.fetch = async () => ({ json: async () => googleReply });
  const out = { status: 200, headers: {}, body: '' };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    status(c) { out.status = c; return this; },
    send(b) { out.body = b; },
    writeHead(c, h) { out.status = c; Object.assign(out.headers, h); },
    end() {},
  };
  return Promise.resolve(handler({ url, headers, method, body }, res)).then(() => out);
}
const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const good = { aud: 'cid', hd: 'vaeral.com', email: 'a@vaeral.com', email_verified: true };

// The popup opens on a choice: Google, or a username and password form.
const page = await run(auth, '/api/auth');
assert.equal(page.status, 200);
assert.match(page.body, /href="\/api\/auth\?provider=google"/);
assert.match(page.body, /<form method="post" action="\/api\/callback"/);
assert.doesNotMatch(page.body, /Wrong username or password/);
assert.match((await run(auth, '/api/auth?error=1')).body, /Wrong username or password/);

const start = await run(auth, '/api/auth?provider=google');
const to = new URL(start.headers.Location);
assert.equal(start.status, 302);
assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
assert.equal(to.searchParams.get('redirect_uri'), 'https://www.vaeral.com/api/callback');
assert.match(start.headers['set-cookie'][0], new RegExp(`decap_oauth_state=${to.searchParams.get('state')};`));

const login = (username, password) => ({ method: 'POST', body: { username, password } });
const cases = [
  ['Workspace account on vaeral.com', '?code=c&state=s1', { googleReply: { id_token: idToken(good) } }, 200],
  ['state does not match the cookie', '?code=c&state=forged', { googleReply: { id_token: idToken(good) } }, 400],
  ['personal Google account using a vaeral.com address (no hd)', '?code=c&state=s1', { googleReply: { id_token: idToken({ ...good, hd: undefined }) } }, 403],
  ['another Workspace domain', '?code=c&state=s1', { googleReply: { id_token: idToken({ ...good, hd: 'gmail.com', email: 'a@gmail.com' }) } }, 403],
  ['unverified email', '?code=c&state=s1', { googleReply: { id_token: idToken({ ...good, email_verified: false }) } }, 403],
  ['token minted for another client', '?code=c&state=s1', { googleReply: { id_token: idToken({ ...good, aud: 'other' }) } }, 403],
  ['Google refuses the code', '?code=c&state=s1', { googleReply: { error: 'invalid_grant' } }, 401],
  ['password: right', '', login('gajanand', 'right-pass'), 200],
  ['password: username typed with capitals and spaces', '', login(' Gajanand ', 'right-pass'), 200],
  ['password: wrong', '', login('gajanand', 'wrong-pass'), 303],
  ['password: unknown user', '', login('nobody', 'right-pass'), 303],
  ['password: empty form', '', { method: 'POST', body: {} }, 303],
];
for (const [name, query, opts, status] of cases) {
  const r = await run(callback, '/api/callback' + query, opts);
  assert.equal(r.status, status, name);
  assert.equal(r.body.includes('GH-TOKEN'), status === 200, `${name}: token ${status === 200 ? 'missing' : 'leaked'}`);
  if (status === 303) assert.equal(r.headers.Location, '/api/auth?error=1', `${name}: back to the form`);
}
console.log(`CMS sign-in: ${cases.length + 2} checks passed (only vaeral.com Workspace accounts and CMS_USERS logins get the GitHub token).`);
