// Google sign-in for Decap CMS — step 1 of 2.
//
// Decap opens this endpoint in a popup. We redirect the user to Google's sign-in,
// asking only for their identity (`openid email`). A random `state` is stored in a
// short-lived, httpOnly cookie so the callback can verify the round-trip (CSRF
// protection). /api/callback decides who may in and hands Decap the GitHub token.
//
// Required env vars (set in Vercel project settings, NOT committed):
//   OAUTH_GOOGLE_CLIENT_ID      — the Google OAuth client's ID
//   OAUTH_GOOGLE_CLIENT_SECRET  — used by /api/callback (not here)
//   CMS_GITHUB_TOKEN            — used by /api/callback (not here)
// See docs/CMS-ADMIN-SETUP.md.

import crypto from 'node:crypto';

export default function handler(req, res) {
  const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('OAuth is not configured: OAUTH_GOOGLE_CLIENT_ID is missing.');
    return;
  }

  // The origin hosting this function — used to build the callback URL. Google only
  // accepts it if it is listed on the OAuth client (www.vaeral.com in production).
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/callback`;

  const state = crypto.randomBytes(16).toString('hex');

  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid email');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('hd', 'vaeral.com'); // a hint for the account chooser; /api/callback enforces it
  authorizeUrl.searchParams.set('prompt', 'select_account');

  res.setHeader('Set-Cookie', [
    `decap_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);
  res.writeHead(302, { Location: authorizeUrl.toString() });
  res.end();
}
