/**
 * One-time setup script to obtain a Gmail OAuth2 Refresh Token.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com/
 *   2. Create a project (or use an existing one).
 *   3. Enable the Gmail API:
 *      APIs & Services > Library > search "Gmail API" > Enable.
 *   4. Create OAuth2 Credentials:
 *      APIs & Services > Credentials > Create Credentials > OAuth client ID.
 *      - Application type: Web application
 *      - Authorized redirect URIs: http://localhost:3000/callback
 *   5. Copy the Client ID and Client Secret.
 *
 * Usage:
 *   node scripts/get-refresh-token.cjs YOUR_CLIENT_ID YOUR_CLIENT_SECRET
 *
 * The script will open a URL in your terminal. Open it in a browser,
 * sign in with your Gmail account, and authorize the app.
 * It will redirect to localhost:3000/callback and print your Refresh Token.
 * Paste that token into your Vercel environment variables as GMAIL_REFRESH_TOKEN.
 */

const http = require('http');
const url = require('url');
const https = require('https');
const querystring = require('querystring');

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/get-refresh-token.cjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = 'https://mail.google.com/';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  querystring.stringify({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

console.log('\n=== Gmail OAuth2 Refresh Token Setup ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for authorization...\n');

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400);
    res.end('No authorization code received.');
    return;
  }

  // Exchange authorization code for tokens
  const postData = querystring.stringify({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokenReq = https.request(
    {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    },
    (tokenRes) => {
      let body = '';
      tokenRes.on('data', (chunk) => (body += chunk));
      tokenRes.on('end', () => {
        try {
          const tokens = JSON.parse(body);
          if (tokens.refresh_token) {
            console.log('=== SUCCESS ===\n');
            console.log('Your Refresh Token:\n');
            console.log(tokens.refresh_token);
            console.log('\nAdd this to your Vercel environment variables as GMAIL_REFRESH_TOKEN.');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Success!</h1><p>Refresh token has been printed in your terminal. You can close this tab.</p>');
          } else {
            console.error('Error: No refresh_token in response:', tokens);
            res.writeHead(500);
            res.end('Failed to get refresh token. Check terminal output.');
          }
        } catch (e) {
          console.error('Error parsing token response:', e.message);
          res.writeHead(500);
          res.end('Error parsing response.');
        }
        server.close();
        process.exit(0);
      });
    }
  );
  tokenReq.on('error', (e) => {
    console.error('Token request error:', e.message);
    res.writeHead(500);
    res.end('Token exchange failed.');
    server.close();
    process.exit(1);
  });
  tokenReq.write(postData);
  tokenReq.end();
});

server.listen(3000, () => {
  console.log('Listening on http://localhost:3000 for OAuth callback...');
});
