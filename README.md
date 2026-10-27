# Vaeral website

Marketing site for **Vaeral** (www.vaeral.com), a Reddit/Quora/ORM agency.

## What this actually is

The site was **designed and built in Framer**, then run through a third-party static
exporter. The pages are large, frozen HTML exports that **still load fonts, images and the
Framer runtime from `framerusercontent.com`**, so the site depends on Framer's CDN at runtime.

We are **not rebuilding** the design. `build.js` renders Markdown content into those exports
through explicit `<!--CMS:*-->` markers and patches the exported homepage. Content is edited in
**Decap CMS** at `/admin`, which commits to this repo: blog posts, case studies, service pages
and pages such as /about. [CLAUDE.md](CLAUDE.md) is the orientation map;
[docs/CMS-PLAN.md](docs/CMS-PLAN.md) has the history and every known gotcha.

## Layout

- `content/` — the Markdown the CMS edits: `blog/`, `case-studies/`, `services/`, `pages/`.
- `build.js` — the build. `schema.js` (JSON-LD), `team-wheel.js` and `framer-forms.js`
  (patched Framer chunks).
- `templates/` — the marker templates; `templates/source/` holds the original case-study exports.
- `index.html` — the homepage Framer export, the build's input for `/`.
- `dist/` — the build output Vercel serves.
- `public/admin/` (Decap), `public/assets/` (images, including CMS uploads).
- `api/` — Vercel functions: the CMS's GitHub OAuth proxy and the contact/newsletter forms.
- `scripts/` — validation, the live health check, the render check, IndexNow.

## Dependencies

Runtime: the published pages pull fonts, images and the runtime from `framerusercontent.com`.

Build tooling (Node): `cheerio` and `marked` (templates and Markdown), `front-matter`, `dotenv`,
and `nodemailer` for the form functions. There is **no** Vite/React app.

## Running locally

```bash
npm install
npm run build      # content -> dist/
npx serve dist     # the whole site, blog and /admin included
npm run verify     # build + schema/content checks + a real-browser render check (needs Chrome)
```

Local CMS editing and the other commands are in [CLAUDE.md](CLAUDE.md) and
[docs/CMS-ADMIN-SETUP.md](docs/CMS-ADMIN-SETUP.md).

## Hosting

Deployed on **Vercel**; this Git repo is the source of truth. Vercel builds and deploys `main`
to production on every push, and a CMS publish is a commit to `main`, so it goes live the same
way. Changes in code go on a short-lived branch and reach `main` only when they are ready to ship.

## After publishing new or changed pages

Vercel runs `npm run build`, which does **not** notify any search engine. Two pings are
manual, and both are worth doing when a page is added or substantially rewritten:

```bash
npm run deploy     # verify, then submit every sitemap URL to IndexNow
```

That covers Bing, Yandex, Seznam and Naver. Run it locally *after* the Vercel deploy is
live, because IndexNow fetches the URLs it is given.

**Google does not participate in IndexNow.** Its Indexing API is restricted to
JobPosting/BroadcastEvent, so Google is notified by hand in Search Console: resubmit
`https://www.vaeral.com/sitemap.xml` under *Indexing → Sitemaps*, and for a rewritten page
that is already indexed, use *URL Inspection → Request Indexing*, since a sitemap alone
will not pull a re-crawl forward.
