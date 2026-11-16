// Sign-in for Decap CMS — step 1 of 2.
//
// Decap opens this endpoint in a popup, which first shows a choice: Google (for
// vaeral.com accounts) or a username and password (for people without one), which
// posts to /api/callback. With ?provider=google we redirect to Google's sign-in,
// asking only for the user's identity (`openid email`). A random `state` is stored
// in a short-lived, httpOnly cookie so the callback can verify the round-trip (CSRF
// protection). /api/callback decides who may in and hands Decap the GitHub token.
//
// Required env vars (set in Vercel project settings, NOT committed):
//   OAUTH_GOOGLE_CLIENT_ID      — the Google OAuth client's ID
//   OAUTH_GOOGLE_CLIENT_SECRET  — used by /api/callback (not here)
//   CMS_GITHUB_TOKEN            — used by /api/callback (not here)
//   CMS_USERS                   — used by /api/callback (not here)
// See docs/CMS-ADMIN-SETUP.md.

import crypto from 'node:crypto';

function renderChoice(failed) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in · Vaeral CMS</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eff0f4; color: #313d3e;
    font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: min(340px, calc(100vw - 32px)); background: #fff; border-radius: 8px; padding: 24px;
    box-shadow: 0 2px 6px rgba(68, 74, 87, .15); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  a.google, button { display: block; width: 100%; box-sizing: border-box; padding: 10px; border-radius: 6px;
    border: 0; font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
  a.google { background: #313d3e; color: #fff; }
  p.or { text-align: center; color: #798291; margin: 16px 0; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 12px; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 9px; font: inherit;
    border: 1px solid #c7cbd1; border-radius: 6px; }
  button { background: #3a69c7; color: #fff; margin-top: 4px; }
  p.error { color: #b3261e; font-size: 13px; margin: 0 0 12px; }
</style></head><body><main>
<h1>Sign in to Vaeral CMS</h1>
<a class="google" href="/api/auth?provider=google">Continue with Google (vaeral.com)</a>
<p class="or">or</p>
<form method="post" action="/api/callback">
${failed ? '<p class="error" role="alert">Wrong username or password.</p>' : ''}
<label>Username <input name="username" autocomplete="username" autocapitalize="none" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
</main></body></html>`;
}

export default function handler(req, res) {
  const url = new URL(req.url, 'https://placeholder');
  if (url.searchParams.get('provider') !== 'google') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderChoice(url.searchParams.has('error')));
    return;
  }

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
