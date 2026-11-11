# CMS Admin Setup — Decap + Google sign-in

How the `/admin` editor is wired, and the one-time steps a human must do (the Google OAuth
client, the GitHub token, the Vercel env vars). Code lives in `public/admin/` (the editor) and
`api/auth.js` + `api/callback.js` (the sign-in proxy). Architecture rationale is in
[CMS-PLAN.md](CMS-PLAN.md) §7.

## How it works

```
Editor → www.vaeral.com/admin  (Decap CMS, public/admin/index.html + config.yml)
  → "Sign in with Google" → popup to /api/auth
  → /api/auth redirects to Google sign-in (asks only for `openid email`)
  → Google → /api/callback?code=… → exchanges the code for the user's ID token
  → only a verified Google Workspace account on vaeral.com passes (`hd`, `email_verified`, `aud`)
  → the CMS's GitHub token is postMessaged back to Decap → Decap commits Markdown to GitHub
  → Vercel rebuilds (npm run build) → live
```

Decap still runs its `github` backend; only the sign-in in front of it is Google. The Google
client secret and the GitHub token live only in Vercel env. The GitHub token does reach the
signed-in editor's browser (Decap calls the GitHub API directly), which is why it is scoped to this
one repo. The button's "Sign in with Google" label is set by a small script in
`public/admin/index.html`; Decap's own label says GitHub.

Every CMS commit is authored by the token's owner, not by the editor who published.

## One-time setup (human actions required)

### 1. Google OAuth client

Google Cloud console → **APIs & Services → Credentials** → the CMS's OAuth client (type **Web
application**) → **Authorized redirect URIs** → add `https://www.vaeral.com/api/callback`.

Use the `www` host. The apex `vaeral.com` redirects to `www`, and an apex callback broke the
handshake with a cross-origin block (`3af51bd`, 2026-07-15).

If the project's **OAuth consent screen** is in *Testing*, only listed test users can sign in:
make it **Internal** (Workspace only) or publish it. `openid email` needs no Google review.

### 2. GitHub token for the CMS

GitHub (as `lakshya-vaeral`) → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:

| Field | Value |
|---|---|
| Repository access | Only select repositories → `lakshya-vaeral/vaeral-website` |
| Permissions | **Contents: Read and write** (Metadata: Read is added automatically) |
| Expiration | the longest offered. **When it expires the CMS stops working**, so note the date. |

### 3. Set Vercel environment variables

Vercel project → **Settings → Environment Variables** (Production + Preview), type *Sensitive*:

| Name | Value |
|---|---|
| `OAUTH_GOOGLE_CLIENT_ID` | the Google client ID from step 1 |
| `OAUTH_GOOGLE_CLIENT_SECRET` | the Google client secret from step 1 |
| `CMS_GITHUB_TOKEN` | the token from step 2 |

Redeploy so the functions pick them up. (`OAUTH_GITHUB_CLIENT_ID`/`_SECRET` belonged to the GitHub
sign-in used until 2026-11-11. The `GMAIL_*` variables belong to the site's forms, not the CMS.)

### 4. Who can sign in

Anyone with a Google Workspace account on vaeral.com. To remove someone, suspend or delete their
Workspace account; to change the domain, edit `DOMAIN` in `api/callback.js`.

## Branch: publishing goes live immediately

Since the July cutover `config.yml` has `backend.branch: main` and
`base_url: https://www.vaeral.com`. Decap's editorial workflow is off, so **Publish** commits
straight to `main`, and Vercel deploys `main` to production. There is no draft or review step in
between; the only safety net is the entry's **Draft** checkbox, which keeps it off the site.

## Testing on a Vercel preview

The callback URL is host-specific. To test on `https://<deployment>.vercel.app`:

1. Add `https://<deployment>.vercel.app/api/callback` to the Google client's redirect URIs.
2. Set `backend.base_url` in `config.yml` to that preview origin, **and** `backend.branch` to the
   preview's branch. Left on `main`, anything published while testing goes straight to production.
3. Visit `https://<deployment>.vercel.app/admin`.

`/api/auth` builds its `redirect_uri` from the request host, so the proxy itself needs no
per-environment change.

## Local editing (no OAuth, no proxy)

For local content editing against your own checkout:

```bash
npx decap-server          # terminal 1 — git-backed local backend on :8081
npm run build && npx serve dist   # optional, to preview rendered output
# open public/admin/index.html via any static server, e.g. npx serve public
```

`local_backend: true` in `config.yml` makes Decap talk to `decap-server` (writes
straight to local files, no GitHub login) when served from `localhost`. It has no
effect in production.
