# Vaeral CMS — Implementation Plan

**Status:** Phases 1–6 DONE. The CMS has been live on `www.vaeral.com` since July 2026: Decap commits
to `main` from 2026-06-29, and OAuth runs on the www domain from 2026-07-15. Work after the cutover
(SEO, service pages, forms, phone layout, speed) is in §12; open issues are in §9.
**Editor end-user:** non-technical marketer. **Last updated:** 2026-10-28.
**Workflow:** short-lived branch off `main`, atomic Conventional Commits, no AI signature, keep this
plan updated each step (full conventions in [CLAUDE.md](../CLAUDE.md) → Working practices). The
"all work on `feature/proper-cms`" rule applied until the cutover.

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
| Content types | Blog posts, case studies, service pages, pages (About) | Per stakeholder. Service pages and /about added 2026-07-27 with the SEO work |
| Editor persona | Non-technical marketer | No-code UI required |
| CMS tool | **Decap CMS** | Git-based, free, no DB, fits Vercel+GitHub, content stays in repo |
| Storage | Markdown + frontmatter in this repo | Versioned, portable, no vendor lock-in |
| Host | Vercel (auto-rebuild on push to `main`) | Already in use |

**Non-goals (v1):** redesigning anything; making homepage hero/services/testimonials editable;
removing the Framer CDN dependency; multi-user editing.

---

## 2. How it works

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

Since the cutover the same build also produces the service pages, /about, the three listing pages
and sitemap/robots/llms.txt, and it patches the homepage. The current output map is in
[CLAUDE.md](../CLAUDE.md) → How a page gets built.

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

### Fields added since the first release
- Blog: `seoTitle`, `coverAlt`, `readTime` (computed from word count when blank), and `faqs` (a list
  of question/answer, shown on the page and emitted as FAQ schema). `updated:` feeds the schema's
  `dateModified` but is **not** in the CMS form; the 2 posts that carry it were edited by hand.
- Case study: `seoTitle`.

### Service page — `content/services/<slug>.md` → `/services/<slug>`
Built on the case-study template. Fields: title, seoTitle, slug, category, tags, date, description,
coverImage, draft, three headed sections (`sectionOneHeading`/`sectionOne` through
`sectionThreeHeading`/`sectionThree`) and `faqs`.

### Page — `content/pages/<slug>.md` → `/<slug>` (today only `/about`)
Same template and the same fields as a service page.

---

## 4. Case studies (5 migrated, 7 today)

`online-pharmacy`, `silver-jewellery`, `holiday-membership`, `premium-pet-nutrition`,
`b2b-fintech-platform`.

> **Now 7 (2026-08-13).** `on-demand-services-app` and `ott-streaming-app` were added as content
> only; they have no source export. The homepage shows four case-study cards from the export plus a
> "View all case studies" button to `/casestudies`.

> **Updated 2026-07-27 (SEO Phase 2).** This slug was previously `holiday-memebership` (sic), and
> this plan said to keep the typo "so links don't break". It has now been corrected to
> `holiday-membership`; the old path 301-redirects to the new one in `vercel.json`, so nothing
> breaks. The migration snapshot was renamed to `templates/source/holiday-membership.html` to match.

**Status: DONE (2026-06-28).** All 5 case-study source pages are saved in
`templates/source/<slug>.html` (`online-pharmacy`, `silver-jewellery`, `holiday-membership`,
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
- **Superseded 2026-08-13 (`1d68443`):** the runtime did replace injected content on the 13 pages
  then built from `case-study.html`. The build now strips the page-render runtime from every page on
  that template (`stripFramerPageRuntime`). What only the runtime drew was restored by hand
  afterwards: hover and focus states (`f2e537e`), the phone header (`c550171`, which only took
  effect with `536b579`), the Go back arrow (`86b2cd4`).
- Re-verify after any change on a real browser: open `/blog/using-reddit-marketing`, let JS run, and
  confirm the body stays the reddit-marketing article (not viral-negative).

### Phase 5 — Decap CMS  ☑ (2026-06-29) — DONE, tested end-to-end on the Vercel branch deploy
- [x] `public/admin/index.html` → Decap loader (`decap-cms@^3`, `noindex`). `public/admin/config.yml`
      with **blog** + **case-studies** collections matching §3 frontmatter exactly (blog:
      title/seoTitle?/slug/date/description/coverImage/coverAlt?/readTime?/draft/body; case study:
      title/seoTitle?/slug/category/tags-list/date/description/coverImage?/draft/problem/whatWeDid/results,
      no body). `media_folder: public/assets`, `public_folder: /assets`. `slug: "{{fields.slug}}"`
      keeps filename = frontmatter slug = output folder (holiday-membership). Per-collection
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
- [x] **Human action (one-time, see [CMS-ADMIN-SETUP.md](CMS-ADMIN-SETUP.md)):** GitHub OAuth App created,
      two Vercel env vars set, marketer added as a **Write** collaborator. **End-to-end test PASSED
      (2026-06-29)** on `https://vaeral-website.vercel.app/admin`: GitHub login round-trip, collections
      load, edit → publish → commit → rebuild all work.

**Test setup used (pre-cutover):** Vercel **Production Branch temporarily set to `feature/proper-cms`**
so `https://vaeral-website.vercel.app` serves this branch (vaeral.com DNS not yet repointed). OAuth App
homepage/callback + `config.yml` `base_url` all on `https://vaeral-website.vercel.app`. Root Directory left
at repo root. At cutover (Phase 6): merge to `main`, flip Production Branch back to `main`, switch
`base_url` + OAuth callback to `https://vaeral.com`.

**Two blockers found & fixed during testing (2026-06-29):**
- **`/admin` not shipped.** `build.js` copied only `public/assets` → `dist/assets`; Vercel serves only
  `dist/`, so the Decap editor never reached `dist/admin` and `/admin` 404'd. Fixed: build now also copies
  `public/admin` → `dist/admin` (commit `fe61481`).
- **`config.yml` 404 at `/admin` (no trailing slash).** Decap's relative `config.yml` fetch resolved to
  `/config.yml` at the site root. Fixed with an absolute `<link rel="cms-config-url" href="/admin/config.yml">`
  in the loader (commit `b2e6ac6`).

**Decisions (2026-06-29):** Used a **self-hosted OAuth proxy** (not a third-party like Netlify) since we're
on Vercel — Decap `base_url`/`auth_endpoint` point at our own `/api`. `base_url: https://vaeral.com`;
preview testing requires temporarily pointing `base_url` + the OAuth App callback at the preview origin
(documented). Kept `backend.branch` on `feature/proper-cms` so the CMS is testable before merge — house
rule "never touch main" holds until cutover. Setup steps a human must do are in CMS-ADMIN-SETUP.md (the
OAuth App + secrets + collaborator invite can't be done from code).

### Phase 6 — Cutover to production (`main` / `www.vaeral.com`)  ☑ (July 2026)

Done. The step-by-step cutover plan written on 2026-06-29 is in git history (`5a18d1c`). State,
re-verified on 2026-10-28 against the Vercel API and the live site:

- [x] Domain: `www.vaeral.com` serves production; the apex `vaeral.com` redirects to it.
- [x] `public/admin/config.yml`: `backend.branch: main` (`aa3c7f7`, 2026-06-29) and
      `base_url: https://www.vaeral.com` (`3af51bd`, 2026-07-15; the www host fixed a cross-origin
      block in the OAuth handshake).
- [x] Vercel Production Branch is `main`.
- [x] OAuth: `/api/auth` sends GitHub `redirect_uri=https://www.vaeral.com/api/callback`, and
      `/admin/` and `/admin/config.yml` return 200.
- [x] Publishing works on production: the Decap commit `e9f5b4e` ("Update Blog posts “what-is-aeo”",
      2026-08-21) landed on `main` and deployed. Most content since then was added through git.
- [x] Legacy env vars `ADMIN_PASSWORD`, `GITHUB_PAT` and `GITHUB_REPO` are gone. Production env holds
      only `GMAIL_*` (forms) and `OAUTH_GITHUB_*` (CMS login).
- [x] Sitemap and robots generated by the build since `fa14e2b` (2026-07-27), plus `llms.txt`.
- [x] Redirects: the old `holiday-memebership` slug and the old WordPress URLs 301 in `vercel.json`;
      `npm run health` checks a sample of them.
- [x] Per-page SEO/OG tags and JSON-LD on every page (`schema.js`). GA stays `G-NYP7J14402`.
- [ ] Optional, not done: delete the merged `feature/proper-cms` branch. It is still on `origin`, as
      are `feature/cms-integration` and `feature/google-preferred-sources`.
- Homepage cards: the services section is now built from `content/services`. The case-study and
  blog cards are still the export's and change only by hand (§9).

---

## 9. Open questions / risks

- ~~OAuth onboarding~~ — **CONFIRMED 2026-06-28:** Decap + GitHub login accepted (§7).
- ~~Missing case-study source pages~~ — **RESOLVED:** all 5 provided 2026-06-28 (§4).
- **Homepage cards:** the services section is generated from `content/services`, and a nav link and
  a "View all case studies" button lead to `/casestudies`. The case-study and blog cards are still
  the export's and change only by hand. **ACCEPTED by stakeholder 2026-06-28.**
- **Framer CDN dependency** remains (fonts/images/runtime). Out of scope but a standing fragility.
- **`updated:` is not editable in the CMS.** The build uses it, but the marketer cannot set it.
- **PageSpeed measures the homepage hero late.** It runs an older Chrome (153 on 2026-10-28) that
  counts the hero image only when Framer re-renders it, so its LCP stays near 10s although visitors
  see the hero at about 0.5s. Test with PageSpeed's own Chrome version before promising a score.

**Found by the phone audit of 2026-10-28, waiting on a decision:**
- Homepage blog cards: the titles sit on busy photos with nothing behind them and are hard to read,
  at every width. A dark gradient behind the text would fix it, but it is a design change.
- The homepage "93% of consumers…" banner is an image with its text baked in, too small to read on
  a phone. It needs a phone-sized asset from the designer.
- Copy typos from the export: "Response Managment" (homepage case-study card) and "Write you email
  here…" (newsletter placeholder, every page).
- The header on the 18 template pages works on phones but is tall (logo, two rows of links, button).
  A menu button like the homepage's would need a small script, since those pages have no runtime.

**Found by the SEO/GEO audit of 2026-10-28, waiting on a decision:**
- The homepage card is still titled "Review Seeding", with "Insert Review" buttons in its graphic,
  and claims "an average 2-star rating improvement within 90 days" without a source. July's
  approved copy changes did not cover these. The "Response Management" card's description is
  LinkedIn copy ("Build founder authority and thought leadership").
- `/services/reddit-marketing` ranks 2-3 for "reddit marketing agency" (US, UK) with 0 clicks
  from 115 impressions since July: its meta description needs a rewrite.
- Posts and case studies credit the organisation as author; a named author (the founder, with his
  own LinkedIn in `sameAs`) needs his URL and consent.
- `/blog/remove-reddit-post-google` is "Crawled - currently not indexed" (since 2026-08-25); it is
  a 2-minute read and probably needs expanding before Request Indexing.
- Off-site, and the largest lever for AI answers: Vaeral is absent from the directories and "best
  Reddit/Quora agency" lists AI engines cite. Clutch reviews, DesignRush/GoodFirms listings, Bing
  Webmaster Tools.
- The homepage's raw HTML repeats its text 2.5x (Framer's per-breakpoint copies; testimonials 8x),
  which CSS-blind crawlers read as repetition. Hard to fix safely inside the export.

**Housekeeping:**
- About 47 one-off scripts have collected at the root again since the Phase 1 cleanup, plus the
  legacy `blog/` folder. Nothing imports them.

## 10. Running locally

See [CLAUDE.md](../CLAUDE.md) → Commands. In short: `npm install`, `npm run build`, then
`npx serve dist` for the whole site, blog and `/admin` included. `npm run check:render` needs Chrome:
point `CHROME_PATH` at a Chrome or chrome-headless-shell binary. Decap locally: `npx decap-server`,
then open `/admin` (the config has `local_backend: true`). `vercel dev` runs the API functions
(OAuth, forms) locally.

## 11. Handover — onboarding a new developer

Everything needed to *understand and continue* the work is committed: this plan
(decisions + dates + phase status), [CLAUDE.md](../CLAUDE.md) (house rules +
orientation), [CMS-ADMIN-SETUP.md](CMS-ADMIN-SETUP.md) (OAuth/admin setup), the
build (`build.js`), templates (`templates/`), content (`content/`), the Decap
editor (`public/admin/`), and the OAuth proxy (`api/auth.js`, `api/callback.js`).
A new dev can read those and pick up with full context.

**What is deliberately NOT in the repo (must be transferred out-of-band — these
are secrets/access, not code):**
- **Gmail OAuth** for the forms (`GMAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
  `GMAIL_REFRESH_TOKEN`) — Vercel env only; `scripts/get-refresh-token.cjs` mints a new token.
- **GitHub OAuth App** Client ID + **Client secret** — live only in the GitHub
  OAuth App settings and the Vercel env vars (`OAUTH_GITHUB_CLIENT_ID`,
  `OAUTH_GITHUB_CLIENT_SECRET`). A new dev needs access to the GitHub account/org
  (`lakshya-vaeral`) that owns the OAuth App, or must register a new one.
- **Vercel project access** — Production Branch, domains/DNS, env vars, build
  settings all live in the Vercel dashboard. Invite the new dev to the Vercel team.
- **GitHub repo admin** — to manage the marketer's collaborator access and the
  OAuth App. Invite the new dev with appropriate rights.
- The **marketer's GitHub account** (the publishing identity) — just needs Write
  collaborator access on the repo; not a secret, but worth noting who it is.

**First-15-minutes checklist for the new dev:**
1. Read [CLAUDE.md](../CLAUDE.md) then this plan top-to-bottom.
2. `npm install` (package-lock is gitignored; deps: cheerio/marked/front-matter/dotenv/nodemailer).
3. `npm run build` → confirm `dist/` regenerates clean (incl. `dist/admin/`).
4. Get invited to the **Vercel project** and **GitHub repo**; locate the OAuth App.
5. Current state: **all six phases done**, live on `www.vaeral.com` from `main`. Later work is in
   §12, open items in §9.

**Gotchas already paid for (don't rediscover them):** `/admin` must be copied into
`dist/` by the build; Decap needs the absolute `cms-config-url` link or it 404s the
config at `/admin`; blog pages need the `framer/handover` CMS record patched or
hydration clobbers injected content (Phase 4); local `blog-*.jpg` covers are actually
WebP; the `holiday-memebership` slug was corrected to `holiday-membership` on 2026-07-27 (301 in place);
pages built on `case-study.html` have no Framer runtime, so anything the runtime drew (nav variants,
icons, hover states) has to be restored at build time; Framer's CSS is scoped to the page root
(`.framer-y31P2` on those pages) and its inline layout beats any stylesheet, so overrides need the
same scope or must target the parent.

## 12. After the cutover (July–October 2026)

What changed once the CMS was live, by theme. Commit messages carry the measurements and reasoning.

- **SEO programme (2026-07-27, PRs #5–#15):** metadata and slug fixes, JSON-LD on every page
  (`schema.js`), service pages, /about, /services, sitemap and robots (`fa14e2b`), real nav routes,
  IndexNow, blog structure fixes, `llms.txt`, AI crawlers named in robots, the live health check and
  Search Console report (`830a592`), and homepage copy brought inside policy (`778c150`).
- **Rendering safety (2026-08-13):** the page runtime stripped from template pages (`1d68443`), CMS
  content made to fail loudly rather than ship invisible (`9afa050`), a page root clipped at a
  hard-coded height (`7fd82ca`), and a real-browser render check (`c550171`).
- **Content:** case studies `on-demand-services-app` (`85170f0`) and `ott-streaming-app`
  (`98fb0e4`); four more service pages (`78f0803`), ten in all; the AI-search and Quora clusters
  (`35492db`, `29908c9`, `54496b2`), eleven posts in all; em dashes taken out of the copy (`0706b63`).
- **Homepage:** the services section generated from `content/services` (`6033b0c`, rebuilt as a
  split layout in `d541691` and as a haloed-ring list in `cb5b196`); a case-studies nav link and CTA
  (`1be0ae1`); the team wheel grown to 16 (`24efc0a` onwards); the Play Store card animation
  (`86d0c10` onwards); the Google Preferred Sources button (`c74bd28` onwards). The July copy
  corrections (`778c150`) reached only the HTML, so hydration put the original wording back ("we
  seed authentic reviews", the 95%/100%/13-month stats) for every visitor and Googlebot until
  2026-10-28, when they were applied to the page module `team-wheel.js` serves as well.
- **Forms (2026-09-19 to 09-23):** every form goes to our own endpoints (`cb6c837`), Framer's form
  backend removed from everything served and guarded by the build (`d9d89fa`, `e5479e3`), spam
  handling (`9dbd3ee`), several notification mailboxes (`54cc062`).
- **Phone layout and speed:** one content rail and swipe decks (`e6c8011`, `16f60e6`, `2ab48a5`),
  lazy loading and per-breakpoint preloads (`8a74504`, `bfc7f46`, `64ed98c`), resized photos
  (`b316382`), the homepage hero faded in by CSS rather than after hydration (`f07300e`,
  2026-10-28), and the template-page header, tag chips and Go back arrow fixed (`536b579`,
  `86b2cd4`, 2026-10-28). The taller header that fix allowed turned the late-added Blogs and
  Services links into a layout shift (PageSpeed CLS 0.16-0.23 on /about); on template pages
  `NAV_SCRIPT` now runs straight after the nav instead of at `</body>` (2026-10-28).
- **SEO/GEO audit fixes (2026-10-28):** the 18 runtime-stripped pages carry their final nav (with
  Blogs and Services) in the HTML, so crawlers that skip JS see it and `NAV_SCRIPT` now runs only on
  hydrated pages; the Figtree file is preloaded on those pages, because the /about tag chips sat
  within a few px of wrapping and the font swap moved them (PageSpeed CLS 0.100); trailing-slash
  URLs 308 to the canonical form (`vercel.json`); a real `404.html` (noindex); sitemap hub dates
  taken from content, so the sitemap no longer changes on every build; `npm run health` expects
  founding year 2020 and reports a timeout as a FAIL instead of crashing. Homepage alt text
  (Bing site scan, 2026-10-29): team photos carry each member's name and the content
  illustrations a description (`HOMEPAGE_ALTS`, in the HTML and the page module), cutting empty
  alts from 71 to 22; the rest are decoration and correctly stay empty, plus the Review Seeding
  grid until that card is decided.
- **Operations:** the Google API tooling moved out of the repo (`49500f1`, 2026-10-07);
  `npm run deploy` now verifies and pings IndexNow (`11ee17d`).
- **Process:** one PR per feature until 2026-08-31, then direct commits to `main`; most commits
  from 2026-09-19 to 2026-10-22 used plain-sentence messages. From 2026-10-28, short-lived branches
  off `main` again, with Conventional Commits.
