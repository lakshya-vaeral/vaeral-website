# CMS Admin Setup — Decap + GitHub OAuth

How the `/admin` editor is wired, and the one-time steps a human must do (create
the GitHub OAuth App, set Vercel env vars, add the marketer as a collaborator).
Code lives in `public/admin/` (the editor) and `api/auth.js` + `api/callback.js`
(the OAuth proxy). Architecture rationale is in [CMS-PLAN.md](CMS-PLAN.md) §7.

## How it works

```
Marketer → vaeral.com/admin  (Decap CMS, public/admin/index.html + config.yml)
  → "Login with GitHub" → popup to /api/auth
  → /api/auth redirects to GitHub authorize (asks for `repo` scope)
  → GitHub → /api/callback?code=… → exchanges code for token (uses client secret)
  → token postMessaged back to Decap → Decap commits Markdown to GitHub
  → Vercel rebuilds (npm run build) → live
```

The OAuth **client secret never reaches the browser** — only the two serverless
functions hold it (via env vars).

## One-time setup (human actions required)

### 1. Create a GitHub OAuth App

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
(org-level under `lakshya-vaeral` if you want it owned by the org).

| Field | Value |
|---|---|
| Application name | `Vaeral CMS` (any name) |
| Homepage URL | `https://vaeral.com` |
| Authorization callback URL | `https://vaeral.com/api/callback` |

Click **Register application**, then **Generate a new client secret**. Copy the
**Client ID** and **Client secret** (the secret is shown once).

> Use a **GitHub OAuth App**, not a GitHub App — Decap's `backend: github` flow
> expects the classic OAuth web flow this proxy implements.

### 2. Set Vercel environment variables

Vercel project → **Settings → Environment Variables** (Production + Preview):

| Name | Value |
|---|---|
| `OAUTH_GITHUB_CLIENT_ID` | the Client ID from step 1 |
| `OAUTH_GITHUB_CLIENT_SECRET` | the Client secret from step 1 |

Redeploy so the functions pick them up. (The old `ADMIN_PASSWORD`, `GITHUB_PAT`,
`GITHUB_REPO` vars from the legacy CMS are no longer used and can be deleted.)

### 3. Add the marketer as a repo collaborator

GitHub repo → **Settings → Collaborators → Add people** → invite the marketer's
GitHub account with **Write** access. They sign into `/admin` with that account.
Write access to the repo is what authorizes them to publish.

## Branch / cutover note

`config.yml` `backend.branch` is currently **`feature/proper-cms`** so the CMS can
be tested before the new system is merged to production. Vercel's *production*
deploy builds `main`, so until this branch is merged, edits made in the CMS land
on `feature/proper-cms` and show up on that branch's **preview** deployment, not
on `vaeral.com`. At cutover (Phase 6): merge to `main`, then flip
`backend.branch` to `main`.

## Testing on a Vercel preview (before production DNS)

The OAuth callback URL is host-specific. To test on a preview URL
(`https://<deployment>.vercel.app`) instead of `vaeral.com`:

1. Add a second **Authorization callback URL** to the OAuth App:
   `https://<deployment>.vercel.app/api/callback` (GitHub OAuth Apps allow one
   callback per app — either create a separate "Vaeral CMS (preview)" OAuth App,
   or temporarily switch the callback URL).
2. Set `backend.base_url` in `config.yml` to that preview origin.
3. Visit `https://<deployment>.vercel.app/admin`.

`/api/auth` builds its `redirect_uri` from the request host automatically, so the
proxy itself needs no per-environment change — only the OAuth App callback URL and
`base_url` must match the host you visit.

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
