// GitHub OAuth proxy for Decap CMS — step 1 of 2.
//
// Decap opens this endpoint in a popup. We redirect the user to GitHub's
// authorize screen, asking for `repo` scope (needed to commit content). A
// random `state` is stored in a short-lived, httpOnly cookie so the callback
// can verify the round-trip (CSRF protection).
//
// Required env vars (set in Vercel project settings, NOT committed):
//   OAUTH_GITHUB_CLIENT_ID      — the GitHub OAuth App's Client ID
//   OAUTH_GITHUB_CLIENT_SECRET  — used by /api/callback (not here)
// See docs/CMS-ADMIN-SETUP.md.

import crypto from 'node:crypto';

export default function handler(req, res) {
  const clientId = process.env.OAUTH_GITHUB_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('OAuth is not configured: OAUTH_GITHUB_CLIENT_ID is missing.');
    return;
  }

  // The origin hosting this function — used to build the callback URL so the
  // same code works on production and on Vercel preview deployments.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/callback`;

  const state = crypto.randomBytes(16).toString('hex');

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'repo,user');
  authorizeUrl.searchParams.set('state', state);

  res.setHeader('Set-Cookie', [
    `decap_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);
  res.writeHead(302, { Location: authorizeUrl.toString() });
  res.end();
}
