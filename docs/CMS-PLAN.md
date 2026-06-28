# Vaeral CMS — Implementation Plan

**Status:** Approved; Phases 1–5 code DONE (Phase 5: 2026-06-29 — OAuth App/env/onboarding pending human action). **Branch:** `feature/proper-cms` (all work here, never `main`).
**Editor end-user:** non-technical marketer. **Last updated:** 2026-06-29.
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

### Phase 1 — Cleanup & docs  ☑ (2026-06-28)
- [x] Delete scratch files: `check_*.js`, `find_*.js`, `extract.js`, `replace_assets.js`,
      `extracted_styles.css`. `setup_admin_ui.js` **kept** — remove it in Phase 5 once its
      output is captured in templates.
- [x] Rewrite `README.md` to describe reality (removed false "dependency-free", non-existent
      `src/`, `dist/styles.css`, `dist/app.js`, `_redirects` claims).
- [x] Fix `package.json` scripts and add `vercel.json`. **Decisions (2026-06-28):** dropped the
      dead Vite/React/puppeteer deps (no `src/`, no vite config); `build` → `node build_blog.js`,
      `preview` → `npx serve dist`; kept `cheerio`/`marked`/`front-matter`/`dotenv`. `vercel.json`:
      `outputDirectory: dist`, `cleanUrls: true`, **no build command** — Vercel statically serves
      the committed `dist/` for now; the build command gets wired in once `build.js` lands (Phase 4).
- [x] Add `CLAUDE.md` + this plan.

### Phase 2 — Content model & migration  ☑ (2026-06-28)
- [x] Create `content/blog/` with the 2 existing posts converted HTML→Markdown
      (`using-reddit-marketing`, `viral-negative`). Dates taken from each page's own
      visible header: `2026-04-08` and `2022-03-15`. Covers point at the existing local
      assets (`/assets/blog-reddit-marketing.jpg`, `/assets/blog-viral-negative.jpg`).
- [x] Create `content/case-studies/` with the 5 case studies (§4). Tags captured per-page
      (they vary). No per-page date exists in the source, so all 5 use `date: 2026-05-27`
      (the §3 reference date) — adjust later if real dates surface. `coverImage` points at the
      shared `/assets/case-study-hero.jpg` (only localized case-study asset; optional field).
      `description` derived from each Problem intro (~160 chars) since the source `<head>` only
      carries the generic homepage meta.
- [x] Clean migration artifacts. **Findings (2026-06-28):**
      - Dropped the corrupted "**esults**" paragraph after every Results heading.
      - **No mojibake in `templates/source/*.html`** — all 5 are clean (0 high-byte
        sequences); `3.2×`, `©️` etc. are already correct. The mojibake noted earlier
        (`brandâs`, `3.2Ã`, `Â©ï¸`) lived in the older live-page snapshot, not these sources,
        so no character fixups were needed.
      - Unwrapped `<strong>`-wrapped section bodies (kept inline stat emphasis like
        `**84%**`, `**3.2× increase**`). H3 sub-headings were also `<strong>`-wrapped — unwrapped.
      - Excluded the hidden duplicate bottom title by stopping extraction at the footer
        ("Join newsletter").
      - Stripped silver-jewellery's redundant `The Problem:` body prefix (duplicated the heading).
- **Known fidelity note:** 4 of 5 case studies (holiday, premium-pet, b2b-fintech,
  silver-jewellery) authored their Results as a single flat run of text in the source (no
  `<li>`/`<br>` — some stats run together, e.g. "693 comments 350+ neutralisation"). Migrated
  faithfully as single paragraphs rather than inventing bullet boundaries; only `online-pharmacy`
  has a real bullet list. The marketer can reformat in the CMS later.
- **Commits:** `cce55fb` (blog), `52305cd` (case studies).

### Phase 3 — Templates  ☑ (2026-06-29)
- [x] `templates/blog.html` with `<!--CMS:*-->` markers (from `blog/viral-negative/index.html`).
- [x] `templates/case-study.html` with `<!--CMS:*-->` markers (from `templates/source/online-pharmacy.html`).
- [x] 5 case-study source HTML files saved in `templates/source/<slug>.html` (done 2026-06-28).

**How it was done (2026-06-29):** a one-shot cheerio generator (not kept — it's recoverable from
`templates/source/` + this spec) loaded each source with `decodeEntities:false`, navigated by
`data-framer-name`, and replaced container contents with comment markers. The deployed pages
already round-trip through cheerio (the old `build_blog.js` writes `$.html()`), so generating the
templates this way produces exactly what the build will emit — cheerio's reserialization
(doctype case, quote/whitespace normalization) is the same churn the pipeline already accepts.
Commit: `d7e085c`.

**Marker vocabulary (shared tokens — Phase 4 does one string-replace per token; values repeat
across tags):**
- `CMS:TITLE` → `<title>`, `og:title`, `twitter:title`, visible `<h1>`, **and** the case study's
  hidden Framer search-index mirror `<p>` (the only `<p>` with no `data-framer-name` ancestor —
  selected structurally, not by text; blog has no such mirror).
- `CMS:DESCRIPTION` → meta description, `og:description`, `twitter:description`.
- `CMS:OG_IMAGE` → `og:image`, `twitter:image` (fill from frontmatter `coverImage`).
- `CMS:URL` → `<link rel="canonical">`, `og:url` (derive from slug: blog `/blog/<slug>`,
  case study `/<slug>`).
- Blog body: `CMS:DATE` (inside `[data-framer-name="Date"] <time>`, datetime attr kept),
  `CMS:BODY` (the inner article `[data-framer-name="Content"] > [data-framer-name="Content"]`).
- Case study body (scoped to `Card CS › Content`): `CMS:CATEGORY` (kept inside its styled `<p>`),
  `CMS:TAGS` (the `Highlights` chip group, emptied), `CMS:PROBLEM`/`CMS:WHATWEDID`/`CMS:RESULTS`
  (the section body containers). The shared `data-framer-name="Short description"` was targeted
  **positionally** within `Card CS › Content` (7 in order: category, _The Problem_, problem,
  _What We Did_, whatwedid, _The Results_, results) — the 3 section **headings** stay static.

**Targeting notes / decisions:**
- Single-line fields (TITLE/CATEGORY/DATE) keep their styled inner element (`h1`/`p`/`time`) with
  the marker inside, preserving the Framer text-preset classes. Rich/multi-paragraph fields
  (BODY/PROBLEM/WHATWEDID/RESULTS/TAGS) empty the container; Phase 4 injects rendered markup. This
  matches the proven old build (`originalTextNode.parent().html(post.body)`), so the inner
  paragraphs lose their `.framer-text` classes — a **Phase 4 concern**: the build (and/or the
  chip prototype recoverable from `templates/source/`) must re-emit styled markup for fidelity.
- **Read time** ("8 min read") is left static — there is no frontmatter field for it (§3). Phase
  4/6 can compute it from word count; flagged so it isn't shipped wrong silently.
- **Hydration risk (§5) still open:** the Framer runtime's serialized component tree (a `<script>`
  data island) still holds the *old* body text — the markers only touch the visible DOM, exactly
  as the old build does. Whether hydration clobbers the injected content must be verified on the
  first real build (Phase 4).

### Phase 4 — Build pipeline  ☑ (2026-06-29)
- [x] `build.js` renders all content → `dist/...`. Replaces `build_blog.js` (deleted). Reads
      `content/blog/*.md` + `content/case-studies/*.md`, skips `draft: true`, renders body with
      `marked`, fills `<!--CMS:*-->` markers via `split/join` (no text matching), writes
      `dist/blog/<slug>/index.html` and `dist/<slug>/index.html`.
- [x] Blog index generation (`dist/blog/index.html`) + URL parity: blog `/blog/<slug>`, case study
      `/<slug>` (top-level, matches homepage `./<slug>` links), listing `/blog`. `cleanUrls` on.
- [x] `package.json` `build` → `node build.js`; `vercel.json` `buildCommand: npm run build`,
      `outputDirectory: dist`.

**How it was done (2026-06-29):**
- **Body fidelity (re-emit Framer presets).** Rich fields empty their Framer container, so marked's
  plain `<p>/<ul>/<a>/…` would lose the `.framer-text` presets. `build.js` re-applies exact preset
  class/attr/style maps captured from the live export (`BLOG_PRESETS`, `CASE_PRESETS`). For case
  studies the light text-color style is **required for legibility** on the dark section background
  (without it injected text would be near-black on dark). Lists are normalised to the Framer
  `<li data-preset-tag="p"><p>…</p></li>` shape. Verified: injected paragraphs/lists carry the same
  classes + color as the original `online-pharmacy` / `viral-negative` markup.
- **Tag chips.** Cloned **byte-exact** from the `templates/source/online-pharmacy.html` Highlights
  prototype (3 chip nodes) with only the `<p>` text swapped; cycles the 3 prototypes if a future
  case study has >3 tags. All 5 current case studies have exactly 3 tags.
- **Read time.** Added `<!--CMS:READTIME-->` + `<!--CMS:DATETIME-->` markers to `templates/blog.html`
  (visible DOM only; the `framer/handover` copies untouched). New optional frontmatter field
  `readTime` (added to the 2 existing posts: 8 / 6 to preserve the original displayed values).
  Absent → computed as `round(words/200)`. **Why a field:** the original Framer read-times are
  inconsistent / not reproducible from word count, and the template hard-coded "8 min read" which
  would have mis-shipped on every other post (the §5 flag). Datetime attr now also matches the post.
- **SEO/OG.** `og:image`/`twitter:image` made absolute (`https://vaeral.com` + `coverImage`; falls
  back to `/assets/og-image.png`). `canonical`/`og:url` derived from slug. Title is HTML-escaped so
  the same value is safe in both attribute (`&quot;`) and text contexts (e.g. online-pharmacy's
  quoted title).
- **Hero image (2026-06-29 follow-up).** Originally the visible hero `<img>` was left as the
  template post's photo (no marker) — so every blog post showed viral-negative's hero. Fixed: added
  `<!--CMS:HERO_SRC/HERO_ALT/HERO_W/HERO_H-->` markers (the framer CDN `srcset`/`sizes` were dropped
  in favour of the local `/assets` image) and `patchBlogHandover` now also rewrites the handover
  cover-image field (`src`/`srcSet`/`pixelWidth`/`pixelHeight`/`alt` at indices 16–20) so hydration
  doesn't re-assert the template photo. New optional `coverAlt` frontmatter field (falls back to
  title). Intrinsic dimensions are read from the file header by `imageSize()`. **Asset quirk:** the
  local `blog-*.jpg` covers are actually **WebP** (RIFF/`VP8X`) with a `.jpg` extension — browsers
  render them fine (content sniffing), and `imageSize()` handles WebP/PNG/JPEG. Heroes use the local
  `/assets` image (not framer CDN) so marketer-uploaded covers will work going forward.
- **Blog listing** (`templates/blog-index.html`) is a new **lightweight standalone page** (GA
  `G-NYP7J14402` + Figtree + dark theme + `<!--CMS:POSTS-->`), **not** a Framer export — no design
  source for a `/blog` listing exists in the repo. Known limitation; upgradeable if a Framer listing
  design is provided.
- **Homepage `dist/index.html` is NOT touched** (deployed Framer export, out of CMS scope; it also
  differs from root `index.html`, the anti-edit copy). `public/assets` is synced → `dist/assets`
  each build so CMS image uploads ship. `dist/` stays committed (current repo convention + static
  fallback).

**Hydration check (§5) — RESOLVED (2026-06-29):**
- Tested locally: the blog DID clobber. Blog pages are Framer **CMS-collection pages** — the runtime
  (`script_main.mjs`) hydrates and re-renders title/date/read-time/**body** from an embedded CMS
  record in the `<script type="framer/handover">` island. DOM-only injection was overwritten on
  hydration: a post built from the shared template showed the *template* post's content. (The old
  `build_blog.js` had the same latent bug; it was just never exercised with a second post.)
- **Fix:** `build.js` now also rewrites that CMS record per blog post — `patchBlogHandover()` sets
  the title/description/date/read-time scalars and regenerates the body as Framer's rich-text AST
  (`[1,[4,"tag",attrs,…],[5,"text"],…]`; blocks get `dir:auto`, headings wrap in `<strong>`, no
  Framer classes — the RichText component applies presets on render). It asserts the handover's
  known shape first and throws if the template drifts, so it can never silently corrupt. The visible
  DOM markers are still filled too (correct pre-hydration paint + no-JS fallback).
- **Why this works without touching JS:** appear-animations (the `opacity:0`→visible reveal) are run
  by **inline** scripts (`animator` + a self-invoking appear runner), independent of the module — so
  we keep the runtime (animations intact) and simply feed it the right content. Verified statically:
  each post's handover + DOM now carry only that post's content; the only cross-post text is the
  legitimate sibling related-post card Framer embeds for navigation.
- **Case studies: SAFE (unchanged).** They are static pages — body text appears **0 times** in any
  `<script>`, so their handover has nothing to re-render and needs no patch.
- Re-verify after any change on a real browser: open `/blog/using-reddit-marketing`, let JS run, and
  confirm the body stays the reddit-marketing article (not viral-negative).

### Phase 5 — Decap CMS  ☑ (2026-06-29, code) — OAuth App/env/onboarding pending human action
- [x] `public/admin/index.html` → Decap loader (`decap-cms@^3`, `noindex`). `public/admin/config.yml`
      with **blog** + **case-studies** collections matching §3 frontmatter exactly (blog:
      title/slug/date/description/coverImage/coverAlt?/readTime?/draft/body; case study:
      title/slug/category/tags-list/date/description/coverImage?/draft/problem/whatWeDid/results,
      no body). `media_folder: public/assets`, `public_folder: /assets`. `slug: "{{fields.slug}}"`
      keeps filename = frontmatter slug = output folder (holiday-memebership kept as-is). Per-collection
      `editor.preview: false` (Framer design can't render in Decap). `local_backend: true` for
      `npx decap-server`. `backend.branch: feature/proper-cms` (flips to `main` at Phase-6 cutover).
- [x] **GitHub OAuth proxy** as two Vercel serverless fns: `api/auth.js` (redirect to GitHub authorize,
      `repo,user` scope, CSRF state cookie) + `api/callback.js` (verify state, exchange code→token with
      the client secret, postMessage handshake `authorization:github:success:…` back to Decap). Secret
      stays server-side via `OAUTH_GITHUB_CLIENT_ID`/`OAUTH_GITHUB_CLIENT_SECRET`. `redirect_uri` is
      derived from the request host so the same code works on production + preview deploys.
- [x] Removed old CMS: `api/publish.js` (password publish), `public/admin/editor.html` (297KB
      contenteditable Framer copy), `setup_admin_ui.js` (LIVE ADMIN injector). No live code referenced
      them. CLAUDE.md "old CMS" note updated to past tense.
- [ ] **Human action (one-time, see [CMS-ADMIN-SETUP.md](CMS-ADMIN-SETUP.md)):** create the GitHub
      OAuth App (callback `https://vaeral.com/api/callback`), set the two Vercel env vars, add the
      marketer as a **Write** collaborator, then run the **end-to-end publish test** on a preview deploy.

**Decisions (2026-06-29):** Used a **self-hosted OAuth proxy** (not a third-party like Netlify) since we're
on Vercel — Decap `base_url`/`auth_endpoint` point at our own `/api`. `base_url: https://vaeral.com`;
preview testing requires temporarily pointing `base_url` + the OAuth App callback at the preview origin
(documented). Kept `backend.branch` on `feature/proper-cms` so the CMS is testable before merge — house
rule "never touch main" holds until cutover. Setup steps a human must do are in CMS-ADMIN-SETUP.md (the
OAuth App + secrets + collaborator invite can't be done from code).

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
