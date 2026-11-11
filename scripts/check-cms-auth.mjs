// scripts/check-cms-auth.mjs — the CMS sign-in hands out a repo-write GitHub token, so check
// who gets it. Runs api/auth.js and api/callback.js with Google faked out; no network.

import assert from 'node:assert/strict';
import auth from '../api/auth.js';
import callback from '../api/callback.js';

Object.assign(process.env, { OAUTH_GOOGLE_CLIENT_ID: 'cid', OAUTH_GOOGLE_CLIENT_SECRET: 'sec', CMS_GITHUB_TOKEN: 'GH-TOKEN' });
const headers = { host: 'www.vaeral.com', 'x-forwarded-proto': 'https', cookie: 'decap_oauth_state=s1' };

function run(handler, url, googleReply) {
  globalThis.fetch = async () => ({ json: async () => googleReply });
  const out = { status: 200, headers: {}, body: '' };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    status(c) { out.status = c; return this; },
    send(b) { out.body = b; },
    writeHead(c, h) { out.status = c; Object.assign(out.headers, h); },
    end() {},
  };
  return Promise.resolve(handler({ url, headers }, res)).then(() => out);
}
const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const good = { aud: 'cid', hd: 'vaeral.com', email: 'a@vaeral.com', email_verified: true };

const start = await run(auth, '/api/auth');
const to = new URL(start.headers.Location);
assert.equal(start.status, 302);
assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
assert.equal(to.searchParams.get('redirect_uri'), 'https://www.vaeral.com/api/callback');
assert.match(start.headers['set-cookie'][0], new RegExp(`decap_oauth_state=${to.searchParams.get('state')};`));

const cases = [
  ['Workspace account on vaeral.com', '?code=c&state=s1', { id_token: idToken(good) }, 200],
  ['state does not match the cookie', '?code=c&state=forged', { id_token: idToken(good) }, 400],
  ['personal Google account using a vaeral.com address (no hd)', '?code=c&state=s1', { id_token: idToken({ ...good, hd: undefined }) }, 403],
  ['another Workspace domain', '?code=c&state=s1', { id_token: idToken({ ...good, hd: 'gmail.com', email: 'a@gmail.com' }) }, 403],
  ['unverified email', '?code=c&state=s1', { id_token: idToken({ ...good, email_verified: false }) }, 403],
  ['token minted for another client', '?code=c&state=s1', { id_token: idToken({ ...good, aud: 'other' }) }, 403],
  ['Google refuses the code', '?code=c&state=s1', { error: 'invalid_grant' }, 401],
];
for (const [name, query, reply, status] of cases) {
  const r = await run(callback, '/api/callback' + query, reply);
  assert.equal(r.status, status, name);
  assert.equal(r.body.includes('GH-TOKEN'), status === 200, `${name}: token ${status === 200 ? 'missing' : 'leaked'}`);
}
console.log(`CMS sign-in: ${cases.length + 1} checks passed (only verified @vaeral.com Workspace accounts get the GitHub token).`);
