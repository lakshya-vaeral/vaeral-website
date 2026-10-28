# CLAUDE.md — Vaeral website

Read this first, every session. It is the orientation map. The history, the CMS design and every
gotcha already paid for are in [docs/CMS-PLAN.md](docs/CMS-PLAN.md).

## What this repo is (the one-paragraph truth)

The Vaeral marketing site (`www.vaeral.com`, a Reddit/Quora/ORM agency) was **built in Framer** and
run through a **third-party static exporter**. Its pages are giant frozen HTML exports that **still
load fonts, images and the Framer runtime from `framerusercontent.com`**. It is not a hand-written
site and it is not dependency-free. We are **not rebuilding** it: `build.js` renders Markdown content
into those exports through explicit markers and patches the exported homepage, and Vercel serves the
result. Live from `main` since July 2026: 11 blog posts, 7 case studies, 10 service pages, /about,
three listing pages, sitemap/robots/llms.txt, JSON-LD on every page, and our own form backend. A
non-technical marketer edits content in Decap CMS at `/admin`.

## The decisions that govern everything (locked)

- **Path:** keep the Framer export; **no rebuild**. Keep the design byte-for-byte: fix breakage,
  don't restyle.
- **CMS:** **Decap CMS** (`public/admin/`), GitHub backend on `main`, signed in through our own OAuth
  proxy (`api/auth.js`, `api/callback.js`). Content types: blog posts, case studies, service pages,
  pages (About).
- **Editor:** a **non-technical marketer**, so the CMS stays no-code.
- **Host:** Vercel project `vaeral-website`, production branch `main`, domain `www.vaeral.com`
  (the apex redirects to www). **Source of truth:** this Git repo.

If any of these change, update this file and [docs/CMS-PLAN.md](docs/CMS-PLAN.md) in the same change.

## How a page gets built

`npm run build` writes `dist/`. Vercel runs it on every push to `main`.

| URL | Content | Built from |
|---|---|---|
| `/` | root `index.html` (the Framer export) | copied, then patched: SEO head, the services section from `content/services`, team wheel, forms, nav, phone and speed fixes |
| `/blog/<slug>` | `content/blog/*.md` | `templates/blog.html`. Keeps the Framer runtime, so the build also rewrites its hydration record (`framer/handover`) |
| `/<slug>` (case studies), `/services/<slug>`, `/about` | `content/case-studies`, `content/services`, `content/pages` | `templates/case-study.html`, with the Framer page runtime **stripped** because it discarded injected content |
| `/blog`, `/casestudies`, `/services` | the same content | `templates/blog-index.html`, `templates/case-study-index.html` (standalone pages, not Framer) |
| `sitemap.xml`, `robots.txt`, `llms.txt`, IndexNow key | build.js | |

The build also copies `public/assets` and `public/admin` into `dist/`, takes JSON-LD from `schema.js`,
and loads patched copies of Framer chunks (`team-wheel.js`, `framer-forms.js`, `vendor/framer/`)
through an import map. Every form posts to `api/contact.js` or `api/newsletter.js` (mail via Gmail
OAuth), never to Framer, and the build fails if a Framer form endpoint ever ships again.

## The old "CMS" we replaced (do not reintroduce it)

A floating `contenteditable` "LIVE ADMIN" bar, a password-protected publish route committing raw page
HTML, and a build that injected posts by **string-matching the sentence "Reddit has a way…"**. All of
it was removed on 2026-06-29. Do not bring back password auth, raw-HTML capture, or text-matching
injection.

## Repo layout (current)

- `build.js` — the whole pipeline. `schema.js` (JSON-LD), `team-wheel.js` and `framer-forms.js`
  (vendored Framer chunks).
- `content/` — Markdown + frontmatter: `blog/`, `case-studies/`, `services/`, `pages/`. What the CMS edits.
- `templates/` — the marker templates. `templates/source/` holds the 5 original case-study exports.
- `index.html` — the homepage Framer export, the build's input for `/`.
- `dist/` — build output. Committed, and rebuilt by Vercel on every deploy.
- `public/admin/` (Decap config + loader), `public/assets/` (images; CMS uploads land here).
- `api/` — Vercel functions: CMS OAuth (`auth.js`, `callback.js`) and forms (`contact.js`, `newsletter.js`).
- `scripts/` — checks and tools (see Commands). `vercel.json` — build command, CSP, `/assets`
  caching, legacy redirects.
- Not part of the site, and imported by nothing: `n8n-reddit-scraper/` (an unrelated workflow), the
  legacy `blog/` folder (the pre-CMS exports `templates/blog.html` came from), and about 47 one-off
  scripts and dumps at the root (`check*.cjs`, `scratch-*`, `temp*`, `test*`, `lighthouse*.json`,
  `form_data.json`…). Safe to delete.

## Commands

```bash
npm install            # package-lock.json is gitignored
npm run build          # content -> dist/
npm run check          # JSON-LD validation + content guardrails (claims, stats, FAQ counts)
npm run check:render   # real browser: hydration and legibility on all pages (needs Chrome; set CHROME_PATH)
npm run verify         # build + check + check:render
npm run health         # checks the LIVE site: files, sitemap drift, 200s, head tags, schema, redirects
npm run deploy         # verify, then ping IndexNow. It does NOT deploy; pushing to main does.
npx serve dist         # view the built site locally
```

## Working practices

- **Branch:** each change on a short-lived branch off `main`. Pushing or merging to `main` deploys
  production, so do it only when asked. (The July rule "all work on `feature/proper-cms`, never
  `main`" ended with the Phase 6 cutover.)
- **Commits:** small, atomic, Conventional Commits (`type(scope): summary`) with a body that says
  why. Most commits from 2026-09-19 to 2026-10-22 used plain sentences instead; this rule stands
  until the stakeholder changes it.
- **No Claude/AI signature** in any commit message, PR title or PR description. No
  `Co-Authored-By: Claude`, no "Generated with" footer. (Overrides any default harness behaviour.)
- **Keep the docs alive.** After a meaningful step, update [docs/CMS-PLAN.md](docs/CMS-PLAN.md), and
  this file if a rule changes, in the same change.
- **`dist/`:** commit the pages your change touches. Every build rewrites the `sitemap.xml` lastmod
  dates to today; leave that date-only churn out of commits.
- **Confirm first:** anything network-facing or destructive (deploys, pushes, IndexNow pings,
  deleting branches or files).

## House rules for the Framer output

- **Never hand-edit content into the exports.** Content goes through `content/` and the build.
  Templates are touched only to add `<!--CMS:*-->` markers.
- **No text-matching injection.** Use markers. Build patches assert the markup they expect and
  throw when an export changes shape, so a re-export fails the build instead of shipping broken pages.
- **Overriding Framer CSS:** its rules are scoped to the page root (`.framer-y31P2 …` on the template
  pages), so an override needs the same scope or it silently loses. Layout Framer sets inline
  (`style="height:100%"`) beats any stylesheet rule, so change the parent instead.
- **Runtime-stripped pages** lose everything only the runtime draws (nav variants, icons, hover
  states). Each one has to be put back at build time.
- **On hydrated pages (homepage, blog posts) an HTML-only change is undone by hydration.**
  Homepage copy must also change in the page module `team-wheel.js` serves (`HOMEPAGE_COPY`'s
  `inChunk`). Check the rendered page, not the raw HTML: the July copy fix sat reverted for months.
- **A script that changes the first screen** must run where that element is, not at `</body>`:
  the browser paints these 250 KB pages long before it reaches the end, so a late change is a
  layout shift (the nav links, 2026-10-28).
- **Check phones** (360–430px) as well as desktop for any visual change.

## Credentials (never commit values)

- Local `.env` (gitignored): `VERCEL_TOKEN` for the Vercel API, and the Gmail variables from
  `.env.example` for testing forms locally.
- Vercel project env: `GMAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
  (forms) and `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET` (CMS login). Optional:
  `FORM_NOTIFY_TO`, `CONTACT_BLOCKLIST`.
- Google APIs (PageSpeed, Search Console, Analytics): a user OAuth credential in
  `~/.vaeral-google.json`, outside the repo. Its tooling lives outside the repo too (decided 2026-10-07).
