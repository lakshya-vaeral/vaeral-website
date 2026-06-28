# Vaeral website

Marketing site for **Vaeral** (vaeral.com) — a Reddit/Quora/ORM agency

## What this actually is

The site was **designed and built in Framer**, then run through a third-party static
exporter. The deployable files are large, frozen HTML exports that **still load fonts,
images, and the Framer runtime from `framerusercontent.com`**. This is **not** a
hand-written, dependency-free site — it depends on Framer's CDN at runtime.

We are **not rebuilding** the design. The Framer export stays as-is. The active work is
replacing the old ad-hoc "CMS" with a proper, git-based one (Decap CMS) for blog posts and
case studies. See [docs/CMS-PLAN.md](docs/CMS-PLAN.md) for the full plan and
[CLAUDE.md](CLAUDE.md) for orientation.

## Layout

- `index.html` — the localized/anti-edit-patched Framer homepage export (~700KB).
- `vaeral_live.html` — the raw original homepage export (kept for reference).
- `dist/` — the deployed output: homepage (`dist/index.html`) + localized `dist/assets/`.
  This is the deploy root.
- `blog/<slug>/index.html` — published blog posts. `blog/viral-negative` is the template source.
- `templates/source/<slug>.html` — the 5 case-study source pages (CMS migration source of truth).
- `public/admin/` — the CMS UI (old custom dashboard, being replaced by Decap).
- `public/assets/`, `dist/assets/` — localized images (logo, og, founder, etc.).
- `build_blog.js` — current blog build (to be rewritten as a marker-based `build.js`, Phase 4).

## Dependencies

Runtime: the published pages pull fonts/images/runtime from `framerusercontent.com`.

Build tooling (Node): `cheerio` (template fill), `marked` (Markdown → HTML), `front-matter`
(parse content frontmatter). There is **no** Vite/React app — content flows through the
build pipeline, not a SPA.

## Running locally

Static site — no build needed just to view the homepage:

```bash
npx serve dist
```

Blog pages and the admin UI require the build / the `public/` copy. The full Decap + Vercel
dev flow is documented in [docs/CMS-PLAN.md](docs/CMS-PLAN.md) §10.

## Hosting

Deployed on **Vercel**; source of truth is this Git repo. Pushing to `main` triggers a
rebuild. CMS work happens on the `feature/proper-cms` branch.
