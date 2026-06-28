# Vaeral CMS — Implementation Plan

**Status:** Approved; Phase 1 not started. **Branch:** `feature/proper-cms` (all work here, never `main`).
**Editor end-user:** non-technical marketer. **Last updated:** 2026-06-28.
**Workflow:** atomic Conventional Commits, commit early/often, no AI signature, keep this plan updated
each step (full conventions in [CLAUDE.md](../CLAUDE.md) → Working practices).

This is the single source of truth for the CMS work. It is written to survive across many chat
sessions: anyone (human or AI) should be able to read this and continue. Keep it updated as
phases complete. See [CLAUDE.md](../CLAUDE.md) for the short orientation.

---

## 1. Goal & decisions (locked)

Build a **proper, reliable CMS** for the existing Framer-exported Vaeral site so a
**non-technical marketer** can create/edit **blog posts** and **case studies** without touching
code, while the **design stays exactly as the current Framer export**.

| Decision | Choice | Why |
|---|---|---|
| Framer | Keep the static export, **no rebuild** | Design is fine; rebuild is out of scope/budget |
| Content types | Blog posts + Case studies | Per stakeholder |
| Editor persona | Non-technical marketer | No-code UI required |
| CMS tool | **Decap CMS** | Git-based, free, no DB, fits Vercel+GitHub, content stays in repo |
| Storage | Markdown + frontmatter in this repo | Versioned, portable, no vendor lock-in |
| Host | Vercel (auto-rebuild on push to `main`) | Already in use |

**Non-goals (v1):** redesigning anything; making homepage hero/services/testimonials editable;
removing the Framer CDN dependency; multi-user editing.

---

## 2. How it will work (target architecture)

```
Marketer → Decap admin (/admin) → edits form/rich-text
        → Decap commits Markdown to GitHub (content/blog/*.md, content/case-studies/*.md)
        → Vercel detects push → runs `npm run build`
            → build renders each Markdown file into the matching Framer page TEMPLATE
              by replacing explicit <!--CMS:*--> markers (NOT text matching)
            → writes dist/blog/<slug>/index.html, dist/<slug>/index.html, dist/blog/index.html
        → Vercel serves dist/ → live
```

Key property: **content is structured data**; the Framer HTML is a **dumb template** with marked
holes. No `contenteditable`, no raw-HTML capture, no fragile sentence matching.

---

## 3. Content models

### Blog post — `content/blog/<slug>.md`
```yaml
---
title: "How to use reddit for marketing: A step-by-step guide"
slug: "using-reddit-marketing"        # = output folder name
date: 2026-05-27
description: "Over 92% of buyers trust…"   # meta description + excerpt
coverImage: "/assets/blog-reddit-marketing.jpg"
draft: false
---
# Markdown body…
```
Output: `dist/blog/<slug>/index.html`. Listed at `dist/blog/index.html`.

### Case study — `content/case-studies/<slug>.md`
Structure derived from the live `online-pharmacy` page (provided 2026-06-28):
```yaml
---
title: "How We Helped a Leading Indian E-Pharmacy Go From \"Is This a Scam?\" to Trusted Household Name"
slug: "online-pharmacy"               # = top-level output folder (matches homepage links: ./online-pharmacy)
category: "Online Pharmacy / Health & Wellness"
tags: ["Reddit Marketing", "Quora Marketing", "Response Management"]   # badge chips
date: 2026-05-27
description: "…"                       # meta/og description
coverImage: "/assets/case-study-hero.jpg"   # optional
draft: false
problem: |                            # rich text (markdown) → "The Problem"
  …
whatWeDid: |                          # rich text (markdown) → "What We Did"
  …
results: |                            # rich text (markdown) → "The Results"
  …
---
```
Output: `dist/<slug>/index.html` (top-level, **not** `/case-studies/`, to match existing
homepage links like `./online-pharmacy`).

> The 3 sections are fixed (Problem / What We Did / Results) because every current case study
> uses exactly that shape — simplest for the marketer. If a future case study needs different
> sections, switch `problem/whatWeDid/results` to a repeatable `sections: [{heading, body}]`
> list widget (noted as a known tradeoff).

---

## 4. The 5 case studies (routes linked from homepage)

`online-pharmacy`, `silver-jewellery`, `holiday-memebership` *(sic — typo in the live route,
keep it so links don't break)*, `premium-pet-nutrition`, `b2b-fintech-platform`.

**Status: DONE (2026-06-28).** All 5 case-study source pages are saved in
`templates/source/<slug>.html` (`online-pharmacy`, `silver-jewellery`, `holiday-memebership`,
`premium-pet-nutrition`, `b2b-fintech-platform`). They do NOT exist elsewhere — these files are
the source of truth for the case-study template + content migration.

Confirmed from all 5: identical structure (title → category → 3 tag chips → Problem / What We
Did / Results). **Tags vary per case study** (e.g. "AEO-First Community Seeding", "Response
Neutralisation") → tags must be an editable list, not fixed. Migration cleanups: every page has
a hidden duplicate title at the bottom wrongly reading "…Leading Indian E-Pharmacy…" (Framer
artifact — the template's title placeholder fixes it); "What We Did" bodies are wrapped in
`<strong>` on most pages; plus the encoding mojibake noted in §8.

---

## 5. Templates (deterministic injection)

Turn one blog page and one case-study page into templates under `templates/`:
- `templates/blog.html` — from `blog/viral-negative/index.html`.
- `templates/case-study.html` — from the `online-pharmacy` page.

Replace the live content inside known containers with explicit markers, e.g.
`<!--CMS:TITLE-->`, `<!--CMS:BODY-->`, `<!--CMS:CATEGORY-->`, `<!--CMS:TAGS-->`,
`<!--CMS:PROBLEM-->`, `<!--CMS:WHATWEDID-->`, `<!--CMS:RESULTS-->`, plus `<head>` markers for
`<title>`, `description`, `og:*`, `twitter:*`, `canonical`, `og:url`.

**Risk to verify:** the page ships the Framer runtime (`script_main…mjs`) which hydrates the
DOM. Confirm that injected SSR content is **not** overwritten on hydration (the current blog CMS
does the same swap and survives, so this is expected to be fine — but verify on first build).

Targeting: prefer `data-framer-name` attributes (human-readable, stable in an export) over
hashed classnames. Note several elements share `data-framer-name="Short description"`, so target
by position within the marked container, not globally.

---

## 6. Build pipeline

Rewrite `build_blog.js` into `build.js` (keep `marked` for Markdown→HTML; keep `cheerio` for
template fill; drop the "Reddit has a way" matching):
1. Read all `content/blog/*.md` and `content/case-studies/*.md` (skip `draft: true`).
2. For each, load the matching template, fill markers, write to the right `dist/` path.
3. Generate `dist/blog/index.html` (blog listing) from a listing template.
4. Generate `public/admin/posts.json`-style manifests if still useful (Decap doesn't need them).
5. `package.json` `build`: drop `vite build` (there's no real Vite app) → just `node build.js`,
   plus a step that copies the static `dist/` shell + `public/assets`. Confirm exact Vercel
   build command + output dir; add `vercel.json` (currently missing).

---

## 7. Decap CMS setup (the editor UI)

- `public/admin/index.html` → Decap's standard loader (replaces the old custom dashboard).
- `public/admin/config.yml` → collections for **blog** and **case-studies** matching §3 exactly,
  with a media folder (`public/assets` or `/assets`) for image uploads.
- **Auth — CONFIRMED (2026-06-28): Decap `backend: github` + GitHub OAuth.** We are on Vercel,
  not Netlify, so git-gateway/Netlify Identity is not used. Deploy a small **GitHub OAuth proxy**
  as a Vercel serverless function (holds the OAuth client secret). The marketer signs in with a
  **GitHub account added as a repo collaborator** (write access). One-time setup; after that the
  editor just sees a normal CMS. Escape hatch if GitHub login ever becomes a problem: swap the
  editor layer to Sanity/TinaCloud (email/password) without redoing the rest.
- Editorial workflow (drafts/PRs) optional; can enable later.

---

## 8. Phases & checklist

Tick boxes as you go. Each phase should end with a commit and a note here.

### Phase 1 — Cleanup & docs  ☐
- [ ] Delete scratch files: `check_*.js`, `find_*.js`, `extract.js`, `replace_assets.js`,
      `extracted_styles.css`. Remove `setup_admin_ui.js` once its output is captured in templates.
- [ ] Rewrite `README.md` to describe reality (remove false "dependency-free", non-existent
      `src/`, `dist/styles.css`, `dist/app.js`, `_redirects` claims).
- [ ] Fix `package.json` scripts and add `vercel.json`. Confirm Vercel project settings.
- [x] Add `CLAUDE.md` + this plan.

### Phase 2 — Content model & migration  ☐
- [ ] Create `content/blog/` with the 2 existing posts converted HTML→Markdown
      (`using-reddit-marketing`, `viral-negative`).
- [ ] Create `content/case-studies/` with the 5 case studies (all source HTML in hand, §4).
- [ ] Clean migration artifacts: the corrupted "**esults**" heading and encoding mojibake
      (`brandâs`→`brand's`, `3.2Ã`→`3.2×`, `Â©ï¸`→`©`, etc.).

### Phase 3 — Templates  ☐
- [ ] `templates/blog.html` with `<!--CMS:*-->` markers.
- [ ] `templates/case-study.html` with `<!--CMS:*-->` markers.
- [x] 5 case-study source HTML files saved in `templates/source/<slug>.html` (done 2026-06-28).

### Phase 4 — Build pipeline  ☐
- [ ] `build.js` renders all content → `dist/...`. Verify hydration doesn't clobber content.
- [ ] Blog index page generation. URL/redirect parity with old paths.

### Phase 5 — Decap CMS  ☐
- [ ] `public/admin/index.html` + `config.yml` (blog + case-studies collections + media).
- [ ] GitHub OAuth proxy on Vercel; marketer onboarded as collaborator; end-to-end publish test.
- [ ] Remove old CMS: `api/publish.js`, `contenteditable` editor, `setup_admin_ui.js`.

### Phase 6 — Polish & launch  ☐
- [ ] Per-post SEO/OG, image upload flow, sitemap if needed, GA stays `G-NYP7J14402`.
- [ ] Redirects for any changed URLs. Full QA on mobile + desktop. Cut over.

---

## 9. Open questions / risks

- ~~OAuth onboarding~~ — **CONFIRMED 2026-06-28:** Decap + GitHub login accepted (§7).
- ~~Missing case-study source pages~~ — **RESOLVED:** all 5 provided 2026-06-28 (§4).
- **Homepage cards** for new blog posts / case studies are hardcoded in `index.html`; v1 does NOT
  auto-update them. New entries get their own page + appear on `/blog`, but adding a homepage
  card stays a manual/dev task unless we extend the build later. **ACCEPTED by stakeholder
  2026-06-28.**
- **Framer CDN dependency** remains (fonts/images/runtime). Out of scope but a standing fragility.

## 10. Running locally

- **View the site:** `npx serve dist` → homepage + localized assets. (Blog/admin need the build
  or the `public/` copy.)
- **Full build:** after Phase 4, `npm run build` → regenerates `dist/`.
- **Decap admin locally:** `npx decap-server` + open `/admin` (after Phase 5), or test on a
  Vercel preview deploy. `vercel dev` runs serverless functions (the OAuth proxy) locally.
