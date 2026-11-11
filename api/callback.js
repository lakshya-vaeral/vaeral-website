// Google sign-in for Decap CMS — step 2 of 2.
//
// Google redirects back here with `?code=...&state=...`. We verify the state
// against the cookie set by /api/auth, exchange the code for the user's ID token,
// and let in only verified Google Workspace accounts on vaeral.com. Those get the
// CMS's GitHub token (a fine-grained token for this one repo, held in Vercel),
// handed to the Decap window via the postMessage handshake its `github` backend
// expects. Decap then reads and commits through the GitHub API as usual.
//
// Required env vars:
//   OAUTH_GOOGLE_CLIENT_ID
//   OAUTH_GOOGLE_CLIENT_SECRET
//   CMS_GITHUB_TOKEN
// See docs/CMS-ADMIN-SETUP.md.

const PROVIDER = 'github'; // Decap's backend, not the sign-in provider
const DOMAIN = 'vaeral.com';

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => {
      const i = c.indexOf('=');
      return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }).filter(([k]) => k),
  );
}

// The page Decap's popup expects: it postMessages the result to the opener
// window and then closes. `content` is JSON-stringified into the message.
function renderHandshake(status, content) {
  const payload = JSON.stringify(content).replace(/</g, '\\u003c');
  return `<!doctype html><html><body><script>
  (function () {
    function send() {
      window.opener.postMessage(
        'authorization:${PROVIDER}:${status}:' + ${JSON.stringify(payload)},
        '*'
      );
    }
    window.addEventListener('message', function () { send(); }, false);
    // Tell the opener we're ready; it replies and we (re)send the result.
    window.opener.postMessage('authorizing:${PROVIDER}', '*');
  })();
  </script></body></html>`;
}

export default async function handler(req, res) {
  const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET;
  const githubToken = process.env.CMS_GITHUB_TOKEN;
  if (!clientId || !clientSecret || !githubToken) {
    res.status(500).send('OAuth is not configured: OAUTH_GOOGLE_CLIENT_ID / OAUTH_GOOGLE_CLIENT_SECRET / CMS_GITHUB_TOKEN missing.');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `${proto}://${host}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies.decap_oauth_state;

  // Clear the state cookie regardless of outcome.
  res.setHeader('Set-Cookie', ['decap_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);

  if (!code || !state || !expectedState || state !== expectedState) {
    res.setHeader('Content-Type', 'text/html');
    res.status(400).send(renderHandshake('error', { message: 'Invalid OAuth state or missing code. Please try signing in again.' }));
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${proto}://${host}/api/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const data = await tokenRes.json();

    if (data.error || !data.id_token) {
      res.setHeader('Content-Type', 'text/html');
      res.status(401).send(renderHandshake('error', { message: data.error_description || data.error || 'Token exchange failed.' }));
      return;
    }

    // The ID token came straight from Google over TLS, so its signature needs no check
    // (Google's OpenID docs allow this); its claims do. `hd` is set only for Workspace
    // accounts, so an ordinary Google account registered with a vaeral.com address fails.
    const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
    if (claims.aud !== clientId || claims.hd !== DOMAIN || claims.email_verified !== true) {
      res.setHeader('Content-Type', 'text/html');
      res.status(403).send(renderHandshake('error', { message: `Sign in with your @${DOMAIN} Google account. ${claims.email || 'This account'} is not allowed.` }));
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(renderHandshake('success', { token: githubToken, provider: PROVIDER }));
  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    res.status(500).send(renderHandshake('error', { message: err.message }));
  }
}
