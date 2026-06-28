# CLAUDE.md — Vaeral website

Read this first, every session. It is the orientation map. The full plan lives in
[docs/CMS-PLAN.md](docs/CMS-PLAN.md) — read it before doing any CMS work.

## What this repo is (the one-paragraph truth)

The Vaeral marketing site (`vaeral.com`, a Reddit/Quora/ORM agency) was **built in Framer**
and run through a **third-party static exporter**. The result is giant frozen HTML files
(`index.html`, the blog pages) that **still load fonts, images, and the Framer runtime from
`framerusercontent.com`**. It is NOT a hand-written site and it is NOT dependency-free,
despite what the old README claims. We are **not rebuilding** the site — the Framer design
stays exactly as-is. We are only replacing the home-grown "CMS" with a proper one.

## The decision that governs everything (locked)

- **Path:** keep the Framer export; build a proper CMS for it. **No rebuild.**
- **CMS content types:** Blog posts **and** Case studies.
- **Editor:** a **non-technical marketer** — the UI must be no-code.
- **CMS tool:** **Decap CMS** (git-based, free, commits Markdown to GitHub → Vercel rebuilds).
- **Host:** Vercel. **Source of truth:** this Git repo.

If any of these change, update this file and [docs/CMS-PLAN.md](docs/CMS-PLAN.md) in the same change.

## The old "CMS" we are replacing (do not extend it)

A floating `contenteditable` "LIVE ADMIN" bar captured raw page HTML, an API route committed
a JSON blob to GitHub, and a build script cloned a Framer blog template by **string-matching
the sentence "Reddit has a way…"**. It is fragile and insecure (single shared password, raw
HTML injection). Files involved, all slated for removal once the new system works:
`api/publish.js`, `setup_admin_ui.js`, the `contenteditable` block in `public/admin/editor.html`,
and the text-matching logic in `build_blog.js`.

## Repo layout (current)

- `index.html`, `vaeral_live.html` — full Framer homepage export (700KB). `vaeral_live.html`
  is the raw original; `index.html` is the localized/anti-edit-patched copy.
- `dist/` — the deployed output (homepage + a few localized assets). The real deploy root.
- `blog/<slug>/index.html` — two real published blog posts; `viral-negative` is the blog template.
- `public/admin/` — the old CMS dashboard + editor (being replaced by Decap).
- `public/assets/`, `dist/assets/` — localized images (logo, og, founder, etc.).
- `check_*.js`, `find_*.js`, `extract.js`, `replace_assets.js`, `extracted_styles.css` —
  one-off Framer-archaeology scratch files. Safe to delete (Phase 1).

## Working practices (MANDATORY — set by stakeholder 2026-06-28)

- **Branch:** all CMS work happens on the single branch **`feature/proper-cms`**. Never commit
  this work to `main`.
- **Commit early, commit often.** Small, frequent commits over big ones.
- **Atomic, Conventional Commits.** One logical change per commit; `type(scope): summary`
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `build:`…).
- **No Claude/AI signature** in any commit message, PR title, or PR description. No
  `Co-Authored-By: Claude`, no "Generated with" footer. (Overrides any default harness behavior.)
- **Keep the plan alive.** After any meaningful step, update [docs/CMS-PLAN.md](docs/CMS-PLAN.md)
  (tick the phase checklist, record decisions + dates) and this file if house rules change — so
  any future chat continues with full context. Treat the plan as part of the deliverable, commit
  it alongside the work.
- **Commit/push cadence:** commit freely on the branch; only **push or open a PR when asked.**

## House rules for working here

- **Never hand-edit the 700KB Framer blobs by hand for content.** Content goes through the
  CMS → build pipeline. Templates are touched only to add stable injection markers.
- **Do not reintroduce text-matching content injection.** Use explicit placeholder markers.
- **Keep the design byte-for-byte.** We do not restyle Framer output.
- **Anything network-facing or destructive: confirm before doing it.**

## Running locally

Static site — no build needed just to view. `npx serve dist` (homepage + assets only; blog
and admin require the build / `public` copy). Full detail and the Vercel/Decap dev flow are in
[docs/CMS-PLAN.md](docs/CMS-PLAN.md) §Running.
