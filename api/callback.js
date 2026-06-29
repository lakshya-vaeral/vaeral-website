// GitHub OAuth proxy for Decap CMS — step 2 of 2.
//
// GitHub redirects back here with `?code=...&state=...`. We verify the state
// against the cookie set by /api/auth, exchange the code for an access token
// using the OAuth App's client secret, then hand the token back to the Decap
// window via the postMessage handshake it expects.
//
// Required env vars:
//   OAUTH_GITHUB_CLIENT_ID
//   OAUTH_GITHUB_CLIENT_SECRET
// See docs/CMS-ADMIN-SETUP.md.

const PROVIDER = 'github';

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
  const clientId = process.env.OAUTH_GITHUB_CLIENT_ID;
  const clientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send('OAuth is not configured: OAUTH_GITHUB_CLIENT_ID / OAUTH_GITHUB_CLIENT_SECRET missing.');
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
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    const data = await tokenRes.json();

    if (data.error || !data.access_token) {
      res.setHeader('Content-Type', 'text/html');
      res.status(401).send(renderHandshake('error', { message: data.error_description || data.error || 'Token exchange failed.' }));
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(renderHandshake('success', { token: data.access_token, provider: PROVIDER }));
  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    res.status(500).send(renderHandshake('error', { message: err.message }));
  }
}
