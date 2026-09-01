// Vaeral CMS build pipeline (Phase 4).
//
// Reads structured content (Markdown + frontmatter) from content/ and renders it
// into the Framer-exported page templates by replacing explicit <!--CMS:*--> markers.
// NO text-matching content injection (the old build_blog.js "Reddit has a way" hack is gone).
//
//   content/blog/<slug>.md          -> dist/blog/<slug>/index.html
//   content/case-studies/<slug>.md  -> dist/<slug>/index.html   (top-level, matches homepage links)
//   (all non-draft blog posts)      -> dist/blog/index.html      (listing)
//
// The homepage (dist/index.html) is NOT touched here — it is the deployed Framer export
// and is out of CMS scope. public/assets is synced into dist/assets so CMS image uploads ship.

import fs from 'node:fs';
import path from 'node:path';
import fm from 'front-matter';
import { marked } from 'marked';
import * as cheerio from 'cheerio';
import * as schema from './schema.js';

const ROOT = process.cwd();
const SITE = 'https://vaeral.com';
const CONTENT = path.join(ROOT, 'content');
const TEMPLATES = path.join(ROOT, 'templates');
const DIST = path.join(ROOT, 'dist');
const PUBLIC_ASSETS = path.join(ROOT, 'public', 'assets');
const DIST_ASSETS = path.join(DIST, 'assets');
const PUBLIC_ADMIN = path.join(ROOT, 'public', 'admin');
const DIST_ADMIN = path.join(DIST, 'admin');
// Source of truth for the tag-chip markup (byte-exact Framer prototype).
const CHIP_SOURCE = path.join(TEMPLATES, 'source', 'online-pharmacy.html');

const cheerioOpts = { decodeEntities: false };

// --- small helpers ---------------------------------------------------------

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toDate = (d) => (d instanceof Date ? d : new Date(`${d}T00:00:00.000Z`));
const fmtDate = (d) =>
  toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const isoDate = (d) => toDate(d).toISOString();

function wordCount(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_`~\-\[\]()!]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function readTimeLabel(attrs, body) {
  const n = attrs.readTime != null ? Number(attrs.readTime) : Math.max(1, Math.round(wordCount(body) / 200));
  return `${n} min read`;
}

function absImage(coverImage) {
  if (!coverImage) return `${SITE}/assets/og-image.png`;
  return /^https?:\/\//.test(coverImage) ? coverImage : SITE + coverImage;
}

// Intrinsic dimensions of a local image, read straight from the file header (JPEG/PNG).
// Used only as an aspect-ratio hint — the hero renders at 100%x100% with object-fit:cover —
// so a sensible fallback is harmless if a format isn't recognised.
function imageSize(coverImage) {
  const fallback = { width: 1600, height: 900 };
  if (!coverImage || /^https?:\/\//.test(coverImage)) return fallback;
  const file = path.join(PUBLIC_ASSETS, path.basename(coverImage));
  if (!fs.existsSync(file)) return fallback;
  const buf = fs.readFileSync(file);
  // PNG: width/height are big-endian u32 in the IHDR chunk at bytes 16/20.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP (RIFF....WEBP) — these local assets are WebP despite a .jpg extension.
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
    }
    if (fourcc === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG: scan segments for a Start-Of-Frame marker; height/width follow at +5/+7.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const isSOF = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return fallback;
}

// Replace every <!--CMS:KEY--> with value (split/join avoids regex-escaping the value).
function fill(template, map) {
  let out = template;
  for (const [key, value] of Object.entries(map)) {
    out = out.split(`<!--CMS:${key}-->`).join(value);
  }
  return out;
}

// Disables Framer's SPA router for internal links by injecting a capture-phase click interceptor.
// This survives React hydration and guarantees all cross-page links do a hard native navigation.
function disableSPARouting(html) {
  const script = `
<script>
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.getAttribute('target') === '_blank') return;
    try {
      const targetUrl = new URL(a.href, window.location.href);
      if (targetUrl.origin === window.location.origin) {
        if (targetUrl.pathname !== window.location.pathname) {
          e.preventDefault();
          e.stopPropagation();
          window.location.href = a.href;
        }
      }
    } catch (err) {}
  }, { capture: true });
</script>
</body>`;
  return html.replace('</body>', script);
}

// Framer's page-render runtime discards everything we inject into case-study.html.
//
// That export shipped without its CMS payload: its __framer__handoverData is a 188-byte
// stub (a collection query with an empty `select` and no records) and its
// data-framer-hydrate-v2 carries no pathVariables, so the runtime has no way to know
// which CMS item the page represents. It resolves the collection itself and renders the
// first item — the e-pharmacy case study — over the top of our content. Every page built
// from this template served the wrong case study to any JS-executing client, Googlebot
// included, while curl saw the correct HTML. That asymmetry is why it went unnoticed:
// the schema validator and health check both fetch raw HTML and both passed.
//
// blog.html ships a full 13.9KB payload with pathVariables and hydrates in place, so it
// keeps its runtime. Do NOT call this for blog pages.
//
// Removing the module script costs the custom cursor and Framer's analytics ping on these
// pages. Layout and typography are CSS, so they are unaffected — verified by screenshot.
function stripFramerPageRuntime(html) {
  const re = /<script type="module"[^>]*src="[^"]*script_main[^"]*"[^>]*><\/script>/g;
  const found = html.match(re) || [];
  if (found.length !== 1) {
    throw new Error(
      `framer runtime strip: expected exactly 1 page-render module script, found ${found.length}. ` +
        'If the export changed, re-check which script re-renders the page before adjusting this.',
    );
  }
  return html.replace(re, '<!-- framer page-render runtime removed: it discards injected CMS content -->');
}

// The export explicitly kills the focus ring on its form fields:
//
//   .framer-form-input:focus-visible { outline: none }
//
// so the newsletter and contact inputs give a keyboard user no indication of where they are.
// Restored with the same ring the buttons use. !important because on the homepage Framer's
// stylesheet can be re-inserted by the runtime after ours, and this must not lose that race.
const FORM_FOCUS_CSS = `
  .framer-form-input:focus-visible {
    outline: 2px solid rgba(197, 185, 246, 0.9) !important;
    outline-offset: 2px;
  }`;

// Colour and typography for CMS content come from the Framer presets in CASE_PRESETS, the
// same route every other injected tag uses. What the export has no rules for at all is
// table *structure* — it never contained a table — so a bare markdown table renders with
// collapsed spacing and no separators. This adds only that: geometry and rules, no colour.
// Scoped to RichTextContainer so it can only affect injected content.
const CONTENT_STYLES = `
<style>
  /* The export hard-codes the page root to height:2172px with overflow:clip — a fixed canvas
     height from Framer, not a response to content — at top level, so it applies at every
     width above the phone breakpoint (which alone gets height:min-content). Anything below
     2172px is therefore clipped away AND excluded from the document's scroll height, so it
     cannot be scrolled to at all.
     Content shorter than 2172px hid this. The shipped case studies ran ~2386px, so their
     footers were already being cut ~213px in; the on-demand study runs 3020px and its footer
     starts at 2359px, entirely below the line, which is why it vanished completely.
     It also survived every check we had: a tall-window screenshot has a viewport taller than
     the document, so the clipped region is still painted and looks correct.
     Restoring content-driven height. Scoped above the phone breakpoint so the existing
     min-content rule there is left alone; overflow stays clipped, which still contains the
     decorative glow horizontally. */
  @media (min-width: 810px) {
    .framer-y31P2.framer-1gd2lyo { height: auto; }
  }
  [data-framer-component-type="RichTextContainer"] table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0 20px;
  }
  [data-framer-component-type="RichTextContainer"] th,
  [data-framer-component-type="RichTextContainer"] td {
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.14);
    /* The export has no colour rule matching th/td — paragraphs get theirs from a
       p-qualified rule — so the cells inherited black on a near-black background. The
       preset does set --framer-text-color on them correctly (verified: #deddff), it just
       had no consumer. Consume the design's own variable rather than pick a colour. */
    color: var(--framer-text-color, #deddff);
  }
  [data-framer-component-type="RichTextContainer"] th {
    font-weight: 600;
    border-bottom: 1.5px solid rgba(255, 255, 255, 0.3);
  }
  [data-framer-component-type="RichTextContainer"] tbody tr:last-child td {
    border-bottom: none;
  }
  /* Narrow screens: scroll the table rather than forcing the page to scroll sideways. */
  @media (max-width: 809.98px) {
    [data-framer-component-type="RichTextContainer"] table {
      display: block;
      overflow-x: auto;
    }
  }
  /* Code, for the same reason as tables: the export has no rules for it, so a snippet from
     the CMS would render as unspaced body text. Colour comes from the preset. */
  [data-framer-component-type="RichTextContainer"] code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    background: rgba(255, 255, 255, 0.07);
    padding: 0.15em 0.4em;
    border-radius: 4px;
  }
  [data-framer-component-type="RichTextContainer"] pre {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 12px 14px;
    margin: 16px 0;
    overflow-x: auto;
  }
  [data-framer-component-type="RichTextContainer"] pre code {
    background: none;
    padding: 0;
  }
${FORM_FOCUS_CSS}
  /* "All case studies" button. Geometry is lifted verbatim from the footer's primary button
     rule (.framer-cTzwY .framer-1uvdw5m), which could not be reused directly because it is
     scoped to the footer. Colours and typography come from the inline recipe on the element,
     the same one the existing buttons use. */
  .vaeral-all-cs {
    display: flex;
    justify-content: center;
    /* Explicit full width: the parent is a flex container, so without this the wrapper shrinks
       to the button and there is nothing to centre within. */
    width: 100%;
    padding: 8px 24px 56px;
    box-sizing: border-box;
  }
  .vaeral-all-cs-btn {
    flex-flow: row;
    flex: none;
    place-content: center;
    align-items: center;
    gap: 10px;
    /* The footer rule uses width:min-content, which works there because Framer's own container
       constrains the button. Standing alone it collapses to the widest single word and the label
       spills outside the pill. max-content sizes to the full one-line label instead. */
    width: max-content;
    box-sizing: border-box;
    height: 44px;
    padding: 12px 24px;
    text-decoration: none;
    display: flex;
    position: relative;
    overflow: visible;
    white-space: nowrap;
  }
  .vaeral-all-cs-btn p {
    margin: 0;
  }
</style>
</head>`;


// Framer drove hover and focus feedback from the page runtime, which had to be removed to stop
// it replacing injected content. Nothing in the export's CSS replaces it: of the 51 :hover rules
// in that stylesheet, only two ever apply, both to inline links inside rich text. So every button
// and nav link on these pages became inert to the pointer — no hover, and no focus ring either,
// which matters more.
//
// filter is used rather than a second set of colours: it stays correct whatever the palette is and
// cannot drift from it, and it works on the purple pills, the dark newsletter button and the
// social icon buttons alike without special-casing each.
//
// Injected ONLY on the pages whose runtime was stripped. Blog posts keep theirs and still have
// working hover, so they are left alone rather than given two competing mechanisms.
const INTERACTION_STYLES = `
<style>
  a[data-framer-name="Primary"],
  a[data-framer-name="In-Active"],
  a.framer-oc284j,
  button[type="submit"][data-framer-name="Default"] {
    cursor: pointer;
    transition: filter 0.15s ease, outline-color 0.15s ease;
  }
  /* hover: hover keeps this off touch devices, where a hover state sticks after a tap. */
  @media (hover: hover) {
    a[data-framer-name="Primary"]:hover,
    button[type="submit"][data-framer-name="Default"]:hover {
      filter: brightness(1.12);
    }
    /* Text links start dimmer than the buttons, so they need a larger lift to read as a change. */
    a[data-framer-name="In-Active"]:hover,
    a.framer-oc284j:hover {
      filter: brightness(1.35);
    }
  }
  a[data-framer-name="Primary"]:focus-visible,
  a[data-framer-name="In-Active"]:focus-visible,
  a.framer-oc284j:focus-visible,
  button[type="submit"][data-framer-name="Default"]:focus-visible {
    outline: 2px solid rgba(197, 185, 246, 0.9);
    outline-offset: 3px;
    border-radius: 4px;
  }

  /* --- Responsive header ------------------------------------------------------------------
     These pages had no responsive nav below 1200px. The cause is not a missing media query:
     this export only ships breakpoint variants for the FOOTER (three ssr-variant wrappers,
     Desktop/Phone/Tablet). Its <nav> has exactly one variant, data-framer-name="Web", so
     there is no phone nav in the DOM to switch to — blog.html by contrast ships nav variants
     ("Web", "Mobile closed"), which is why blog pages get a hamburger and these do not.
     The CSS for a mobile nav variant does exist (.framer-v-cusxc3 sets width:390px and a
     column layout) but nothing can ever apply it, because the markup it belongs to was not
     exported.

     Transplanting the hamburger from blog.html was considered and rejected: its classes are
     scoped to that page's component ids so it would arrive unstyled, and opening the menu is
     runtime-driven — and the runtime is exactly what had to be removed here. A menu that
     cannot open is worse than a row of links that fits.

     So the desktop row is made to degrade instead. The Menu row is pinned to width:1100px
     with no responsive override, inside a nav with overflow:hidden, which is why the links
     were cut off rather than wrapped. Making it fluid and allowing it to wrap keeps every
     destination reachable at any width. */
  @media (max-width: 1199.98px) {
    .framer-Ikdsk.framer-gywbom {
      width: 100%;
      padding: 0 24px;
    }
    .framer-Ikdsk .framer-1tbjop8 {
      width: 100%;
      max-width: 100%;
    }
  }
  @media (max-width: 809.98px) {
    .framer-Ikdsk.framer-gywbom {
      height: auto;
      min-height: 0;
      padding: 12px 16px;
      overflow: visible;
    }
    .framer-Ikdsk .framer-1tbjop8 {
      flex-wrap: wrap;
      place-content: center;
      gap: 10px 16px;
      overflow: visible;
    }
    .framer-Ikdsk .framer-1y9d1w4 {
      flex-wrap: wrap;
      justify-content: center;
      /* width:auto alone is not enough: this row sits in a centred flex parent, so without a
         max-width it grows past the viewport and overflows on both sides — the logo gets cut off
         the left while the last link runs off the right. Constraining it makes the wrap happen. */
      width: auto;
      max-width: 100%;
      min-width: 0;
      gap: 8px 18px;
      overflow: visible;
    }
    /* The link and logo boxes are flex:none, so they also need permission to shrink/wrap. */
    .framer-Ikdsk .framer-1y9d1w4 > * {
      max-width: 100%;
      min-width: 0;
    }
    /* The row holding the menu items is itself flex-wrap:nowrap at a computed 458px, which is
       what actually pushed the last link off a 463px viewport. Measured rather than guessed:
       walking the nav for elements wider than the viewport reported exactly this element. */
    .framer-sSvvD.framer-1tnpw2r {
      flex-wrap: wrap;
      justify-content: center;
      width: auto;
      max-width: 100%;
      min-width: 0;
      row-gap: 8px;
    }
  }
</style>
</head>`;

function injectInteractionStyles(html) {
  if (!html.includes('</head>')) throw new Error('injectInteractionStyles: no </head> found');
  return html.replace('</head>', INTERACTION_STYLES);
}


// Homepage-only: the contact form's submit button (framer-FTivK, which appears on no other page).
//
// It inverts on hover — the runtime turns the background dark — but the label's colour is pinned
// by an inline custom property that the hover variant does not touch, so "Submit" stayed
// rgb(4,1,40) on a dark background and vanished at the exact moment the user went to click it.
//
// Completing the inversion rather than cancelling it, using the button's own two colours: its
// normal text colour becomes the hover background, and the label goes light. No new values.
// !important on the background because the runtime sets that property inline.
const HOMEPAGE_FIX_STYLES = `
<style>
${FORM_FOCUS_CSS}

  button.framer-FTivK[type="submit"] {
    transition: background-color 0.15s ease;
  }
  button.framer-FTivK[type="submit"]:hover {
    background-color: rgb(4, 1, 40) !important;
  }
  button.framer-FTivK[type="submit"]:hover p,
  button.framer-FTivK[type="submit"]:hover .framer-text {
    --framer-text-color: #fff !important;
    color: #fff !important;
  }

  /* Case-study card titles and descriptions were invisible in the tablet range.
     Found by adding the homepage to render-check; measured, not guessed:

       viewport   card title          card description
       1478       rgb(255,255,255)    rgb(155,155,189)
       1258       rgb(0,0,0)          rgb(0,0,0)          <-- black on near-black
        878       rgb(0,0,0)          rgb(0,0,0)          <-- black on near-black
        478       rgb(255,255,255)    rgb(155,155,189)

     So desktop (>=1280) and phone (<=809.98) are both correct and only the tablet
     breakpoint between them lost its colour: those containers carry no colour custom
     property at all, and no preset supplies one in that range. Confirmed visually — at
     1280 the cards showed only their tag chips, with the title and lede invisible.

     This gives the tablet range the exact values the other two breakpoints already use, so
     nothing is invented. :not([style*=extracted-r6o4lv]) restricts it to the containers with
     no colour source, leaving the tag chips (which have one) untouched. */
  @media (min-width: 810px) and (max-width: 1279.98px) {
    [data-framer-name="cards"] [data-framer-component-type="RichTextContainer"]:not([style*="extracted-r6o4lv"]) h3.framer-text {
      --framer-text-color: rgb(255, 255, 255);
    }
    [data-framer-name="cards"] [data-framer-component-type="RichTextContainer"]:not([style*="extracted-r6o4lv"]) p.framer-text {
      --framer-text-color: rgb(155, 155, 189);
    }
  }

  /* --- Clipped heading descenders ---------------------------------------------------------
     The 'y' in "when they do." and the 'g' in "Blogs" were sliced off flat.

     Cause: the ink is taller than the line box it sits in. Plus Jakarta Sans Bold has an
     unusually tall content area - measured, at 52px the inline box is 87px (about 1.67em) -
     while the heading line-height is 1.2em, i.e. 62.4px. So roughly 12px of ink hangs below
     the box. The hero is worse: the h1 is 57px/68.4px but the spans inside it are 68px/81.6px,
     a larger font in a smaller line box, overflowing about 15px.

     Every heading on this preset overflows that way. It only becomes VISIBLE where the nearest
     overflow:hidden ancestor ends exactly at the text's bottom edge - measured as three places:
     the hero h1, "Blogs", and "Still not convinced" (that third one was not reported but is
     clipped identically). "Case Studies" and "Services" overflow too but have hundreds of px
     of slack inside their wrappers, so nothing is cut.

     Fix is bottom padding on those three headings rather than overflow:visible on the wrappers.
     The wrappers are content-sized, so padding grows them and the ink lands inside; removing
     their overflow:hidden would instead risk exposing whatever those masks were drawn to hide,
     and Framer commonly clips these for slide-in reveals. Padding also leaves multi-line
     spacing alone, which a line-height change would loosen. Cost is that these three headings
     sit about 14px lower than before. */
  .framer-13h3br h1 { padding-bottom: 16px; }
  .framer-hz970f h2,
  .framer-1guo6mc h2 { padding-bottom: 14px; }

  /* --- Services section layout ------------------------------------------------------------
     Every value here is measured off the #casestudies section chain so the new section shares
     its rhythm exactly, rather than approximating it:
       .framer-1a0ymfr  section wrapper  gap 100px, max-width 1440px, padding 100px 0 0
       .framer-12qck6g  header block     gap 25px
       .framer-2p1oou   text block       gap 15px
       .framer-eci4z2   h2 container     max-width 700px
       .framer-sk03rn   lede container   max-width 600px
       .framer-fbd1z7   content          max-width 1000px (unset below 810px)
     Colours and type come from the presets and tokens on the elements themselves, not from
     here — this block is layout only. */
  .vaeral-services {
    display: flex;
    flex-flow: column;
    align-items: center;
    width: 100%;
    max-width: 1440px;
    margin: 0 auto;
    padding: 100px 0 0;
    box-sizing: border-box;
    position: relative;
  }
  .vaeral-services-header {
    display: flex;
    flex-flow: column;
    align-items: center;
    gap: 25px;
    width: 100%;
    padding: 0 24px;
    box-sizing: border-box;
  }
  .vaeral-services-text {
    display: flex;
    flex-flow: column;
    align-items: center;
    gap: 15px;
    width: 100%;
  }
  /* These wrappers deliberately do NOT carry data-framer-component-type="RichTextContainer".
     Mimicking the real markup that way pulled in a higher-specificity rule that sets
     position:absolute on those containers — measured: both the heading and the lede computed
     position: absolute, took each other out of flow and painted on top of one another, and a
     plain position: relative here lost the specificity fight. The text presets live on the
     h2/p themselves, so the attribute buys nothing. Same family of trap as the cloned button
     whose absolutely-positioned label contributed no width. */
  .vaeral-services-h2 {
    flex: none;
    width: 100%;
    max-width: 700px;
    height: auto;
    position: relative;
  }
  .vaeral-services-grid {
    display: grid;
    /* Two columns, not three: ten items divide evenly into five rows with no orphan, and each
       card still gets ~490px at the 1000px content width — ample for a label and one line. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    width: 100%;
    max-width: 1000px;
  }
  .vaeral-services-card {
    display: flex;
    flex-flow: column;
    /* position:relative is load-bearing. Framer draws the card edge with an absolutely
       positioned ::after fed by the --border-* properties, so without a positioned card the
       pseudo-element insets to the nearest positioned ancestor — the section — and paints ONE
       border around the whole grid instead of ten card borders. The pill and the case-study
       card both carry position:relative on themselves for this reason. */
    position: relative;
    gap: 6px;
    /* padding borrowed from the case-study card; the pill's 8px/12px is pill-scale. */
    padding: 20px;
    text-decoration: none;
    box-sizing: border-box;
    transition: filter 0.15s ease;
  }
  .vaeral-services-card h3,
  .vaeral-services-card p { margin: 0; }
  /* Label centred. The h3 stretches to the card width by default, so text-align does the
     centring; --framer-text-alignment on the element is the export's own mechanism for it and is
     set alongside, the same way the section headings do it. Size steps down the site's own scale
     from preset-1tx2fj3 (30px h3) to preset-1t2dmrb (24px h4) - same family and weight, one rung
     lighter - rather than inventing a font-size. */
  .vaeral-services-card { text-align: center; }
  @media (hover: hover) {
    .vaeral-services-card:hover { filter: brightness(1.35); }
  }
  .vaeral-services-card:focus-visible {
    outline: 2px solid rgba(197, 185, 246, 0.9);
    outline-offset: 3px;
  }
  /* The export's own phone breakpoint, so this collapses exactly where every other section does. */
  @media (max-width: 809.98px) {
    .vaeral-services { padding-top: 60px; }
    .vaeral-services-grid { grid-template-columns: 1fr; max-width: unset; }
  }
</style>`;

// --- Homepage services section ------------------------------------------------------------
//
// The homepage had no link to any service page at all — the only /services string in the built
// page was inside the nav script, pointing at the hub. Its one services area (#features) covers
// five of the ten services and none of them is a link.
//
// Everything visual here is lifted from elements already on the page, measured rather than
// invented: the section rhythm from the #casestudies chain, the heading and body presets from
// the existing headings, and the card's border/fill/radius from the Service pill — which is one
// of only two components on this page whose CSS is compound-scoped on the element itself AND
// whose whole appearance is inline, so it survives being moved. The case-study cards were
// rejected: ~9KB each with an animated marquee, and every card class carries a hard-coded
// `order:` inside the mobile media query, so a clone jumps position on phones.
const SERVICES_SECTION_CLASS = 'vaeral-services';

// Display order: reputation, then search, then growth. readdirSync order would open the grid
// with "AI Search Visibility, Download and Signup Growth, Search Result Management".
const SERVICES_DISPLAY_ORDER = [
  'review-management',
  'brand-search-results',
  'comment-management',
  'reddit-marketing',
  'quora-marketing',
  'ai-search-visibility',
  'wikipedia-page-creation',
  'linkedin-personal-branding',
  'influencer-marketing',
  'app-store-growth',
];

// Two categories read awkwardly as a grid label. Overridden here rather than by editing the
// service files, which are the owner's copy.
const SERVICES_LABEL_OVERRIDES = {
  'wikipedia-page-creation': 'Wikipedia Pages',
  'app-store-growth': 'Downloads and Signups',
};

const SERVICE_LABEL_COLOUR = '--framer-text-color:var(--token-e374d95c-0883-47b0-9f7c-6ff189c778da, rgb(255, 255, 255))';

// The case-study cards' box, matched to their measured computed values rather than the Service
// pill's. The pill's dark rgb(13,13,13) fill reads muddy at card scale; the case-study cards are
// the site's card language and are transparent with a light border:
//
//   case-study card   background rgba(0,0,0,0)   radius 23px   ::after border 1px rgb(197,184,255)
//   Service pill      background rgb(13,13,13)   radius  6px   ::after border 1px rgb(34,34,34)
//
// Framer draws the edge from an ::after pseudo-element fed by these --border-* custom properties,
// which is why the border is invisible to `border-width` and has to be set this way. The colour is
// the export's own token; declaring it inline is how the export's own elements do it.
const SERVICE_CARD_BOX =
  '--border-bottom-width:1px;--border-color:var(--token-4c441323-6a04-4cdd-b867-6bcb5399d3b3, rgb(197, 184, 255));' +
  '--border-left-width:1px;--border-right-width:1px;--border-style:solid;--border-top-width:1px;' +
  'background-color:rgba(0, 0, 0, 0);border-bottom-left-radius:23px;border-bottom-right-radius:23px;' +
  'border-top-left-radius:23px;border-top-right-radius:23px';

function orderedServices(services) {
  const bySlug = new Map(services.map((s) => [s.slug, s]));
  const ordered = SERVICES_DISPLAY_ORDER.map((slug) => bySlug.get(slug)).filter(Boolean);
  // Anything new that is not in the order list still ships, appended, rather than silently
  // vanishing from the homepage because someone forgot to add it here.
  for (const s of services) if (!SERVICES_DISPLAY_ORDER.includes(s.slug)) ordered.push(s);
  return ordered;
}

function serviceLabel(s) {
  return SERVICES_LABEL_OVERRIDES[s.slug] || s.category || s.title;
}

// No <h1> anywhere in here: render-check compares the first hydrated <h1> against the first
// served one, so an <h1> inserted above the hero's would fail that check even with hydration
// working correctly.
function servicesSectionHtml(services) {
  const cards = orderedServices(services)
    .map(
      (s) =>
        `<a class="${SERVICES_SECTION_CLASS}-card" data-border="true" href="/services/${s.slug}" style="${SERVICE_CARD_BOX}">` +
        `<h3 class="framer-text framer-styles-preset-1t2dmrb" data-styles-preset="FINgGXoDs" dir="auto" style="--framer-text-alignment:center;${SERVICE_LABEL_COLOUR}">${escapeHtml(serviceLabel(s))}</h3>` +
        `</a>`,
    )
    .join('');

  return (
    `<section class="${SERVICES_SECTION_CLASS}">` +
    `<div class="${SERVICES_SECTION_CLASS}-header">` +
    `<div class="${SERVICES_SECTION_CLASS}-text">` +
    `<div class="${SERVICES_SECTION_CLASS}-h2">` +
    `<h2 class="framer-text framer-styles-preset-398jw4" data-styles-preset="QnZFqE78z" dir="auto" style="--framer-text-alignment:center">Our Services</h2>` +
    `</div></div>` +
    `<div class="${SERVICES_SECTION_CLASS}-grid">${cards}</div>` +
    `</div></section>`
  );
}

// Static insert, for crawlers. Placed as the previous sibling of the Case Studies section, which
// is the owner's chosen position. The anchor is the `<section id="casestudies"` opening tag; it is
// unique, so no depth walk is needed here — unlike the CTA, which had to find a container's close.
function patchHomepageServices(html, services) {
  // Structural guard, not textual: the </body> script injection runs BEFORE this patch, so the
  // runtime script's own source (which contains the class name as a string) is already present.
  // Testing for the rendered attribute is the only check that cannot false-positive on it.
  if (html.includes(`class="${SERVICES_SECTION_CLASS}"`)) {
    throw new Error('homepage services: already inserted');
  }
  if (services.length !== SERVICES_DISPLAY_ORDER.length) {
    throw new Error(
      `homepage services: expected ${SERVICES_DISPLAY_ORDER.length} services, found ${services.length}. ` +
        'Add the new slug to SERVICES_DISPLAY_ORDER so its position is deliberate.',
    );
  }

  // Anchor on the id and walk back to the enclosing <section, rather than matching a tag with an
  // assumed attribute order — the export writes `<section class=… data-framer-name=… id=…>`, so
  // anchoring on '<section id="casestudies"' silently matches nothing.
  const idAt = html.indexOf('id="casestudies"');
  if (idAt < 0) throw new Error('homepage services: id="casestudies" not found');
  if (html.indexOf('id="casestudies"', idAt + 1) !== -1) {
    throw new Error('homepage services: id="casestudies" is not unique — insertion point ambiguous');
  }
  const at = html.lastIndexOf('<section', idAt);
  if (at < 0) throw new Error('homepage services: no <section> encloses id="casestudies"');

  return html.slice(0, at) + servicesSectionHtml(services) + html.slice(at);
}

// Runtime re-insert, for users. The static insert above does not survive: the homepage keeps its
// Framer runtime and React reconciliation drops injected elements on hydration — measured on the
// case-studies CTA, whose count went to 0. Same shape as CASE_STUDIES_CTA_SCRIPT: guard on the
// class so it cooperates with the static insert, anchor on a stable landmark, hold it with a
// MutationObserver.
function servicesSectionScript(services) {
  return `
<script>
(function () {
  var CLS = '${SERVICES_SECTION_CLASS}';
  var HTML = ${JSON.stringify(servicesSectionHtml(services))};

  function run() {
    if (document.querySelector('.' + CLS)) return;           // already there, nothing to do
    var target = document.getElementById('casestudies');
    if (!target || !target.parentNode) return;
    var holder = document.createElement('div');
    holder.innerHTML = HTML;
    var section = holder.firstChild;
    if (!section) return;
    target.parentNode.insertBefore(section, target);
  }

  run();
  if (document.body) {
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      run();
      new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
    });
  }
})();
</script>`;
}

// The export's logo links are href="./", which is only correct at one URL depth. A relative
// "./" resolves against the current directory, and these pages are served without a trailing
// slash, so on /services/review-management it resolves to /services/ — the logo took you to the
// services hub instead of home. On the one-level case-study URLs it happened to be right, which
// is why it went unnoticed.
//
// The "Go back" link had the same defect and is handled separately, via the BACK_HREF marker,
// because its correct target differs per page type rather than always being home.
//
// Patched at build time rather than in the template so a re-export cannot silently reintroduce
// the relative form; the count is asserted for the same reason.
const RELATIVE_HOME_LINKS = 4;

function patchRelativeHomeLinks(html) {
  const found = html.split('href="./"').length - 1;
  if (found !== RELATIVE_HOME_LINKS) {
    throw new Error(
      `relative home links: expected ${RELATIVE_HOME_LINKS} href="./" (the logo and its three ` +
        `breakpoint variants), found ${found}. Check what changed before adjusting this.`,
    );
  }
  return html.split('href="./"').join('href="/"');
}

// --- Google "Add as a preferred source" ---------------------------------------
//
// https://developers.google.com/search/docs/appearance/preferred-sources
// vaeral.com is a domain-level publication, which is what the feature requires —
// subdirectory publications (example.com/blog) are not eligible.
//
// It ships on the blog only. That is the publication surface the feature exists
// for; the homepage, services and case-study pages are the agency funnel and a
// follow-us control there would be noise.
//
// The blog INDEX carries the button as plain markup (templates/blog-index.html):
// that template is ours and runs no Framer runtime, so the standard integration
// works as documented — the library scans for the attribute and renders.
//
// POST pages need the script below instead. Measured on dist/blog/viral-negative:
// a probe div placed inside the Framer React root (#main) was already gone when
// the page settled, while an identical sibling outside it survived — React owns
// that subtree and drops anything the export did not put there. So the mount
// point is inserted after hydration, and publisher.js is loaded only once it is
// in place, because the library scans for the attribute immediately on load and
// does not re-scan. Re-renders re-attach the SAME node, which keeps the button
// Google rendered inside it rather than leaving an empty div behind.
const PREFERRED_SOURCE_CLASS = 'vaeral-prefsrc';

const PREFERRED_SOURCE_STYLES = `
<style>
  .${PREFERRED_SOURCE_CLASS} {
    box-sizing: border-box;
    display: flex; align-items: center; justify-content: space-between;
    gap: 20px; flex-wrap: wrap;
    width: calc(100% - 48px); max-width: 820px; margin: 0 auto 8px;
    padding: 20px 22px;
    background: rgba(119, 117, 153, 0.08);
    border: 1px solid rgba(119, 117, 153, 0.28);
    border-radius: 14px;
  }
  .${PREFERRED_SOURCE_CLASS} .txt { flex: 1 1 260px; min-width: 0; }
  .${PREFERRED_SOURCE_CLASS} .t {
    font-size: 16px; font-weight: 600; color: #fff;
    margin: 0 0 4px; letter-spacing: -0.01em; line-height: 1.3;
  }
  .${PREFERRED_SOURCE_CLASS} .s {
    font-size: 14px; line-height: 1.5; color: #9b9bbd; margin: 0; max-width: 62ch;
  }
  /* Google sets width:100% inline on its own mount and fills it with an absolutely
     positioned iframe, so the mount is sized by whatever box we hand it. Left to
     stretch, the iframe's canvas shows beside the button on this dark page. */
  .${PREFERRED_SOURCE_CLASS} .btnwrap { flex: 0 0 auto; width: 238px; max-width: 100%; }
  /* Chrome paints an opaque backdrop behind an iframe when the embedder declares
     color-scheme: dark and the framed document does not. */
  .${PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn] iframe { color-scheme: normal; }
  .${PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn] {
    min-height: 0 !important; height: 48px;
  }
  @media (max-width: 560px) {
    .${PREFERRED_SOURCE_CLASS} { width: calc(100% - 32px); padding: 18px; }
  }
</style>`;

const PREFERRED_SOURCE_HTML =
  '<div class="txt">' +
  '<p class="t">Follow Vaeral on Google</p>' +
  '<p class="s">Add us as a preferred source to see our Reddit, Quora and reputation research higher in Google Top Stories.</p>' +
  '</div>' +
  '<div class="btnwrap"><div google-add-preferred-source-btn data-theme="dark" data-lang="en"></div></div>';

const PREFERRED_SOURCE_SCRIPT = `
<script>
(function () {
  var CLS = '${PREFERRED_SOURCE_CLASS}';
  var HTML = ${JSON.stringify(PREFERRED_SOURCE_HTML)};
  var node = null;
  var loaded = false;

  // Sits directly above the "Read More" section, i.e. at the end of the article.
  // data-framer-name is the export's own landmark, the same kind of hook the
  // case-studies CTA and the services section anchor to.
  function place() {
    var anchor = document.querySelector('[data-framer-name="Read More"]');
    if (!anchor || !anchor.parentNode) return false;
    // Already where it belongs: touch nothing, or the observer below re-triggers
    // on our own write and loops.
    if (node && node.parentNode === anchor.parentNode && node.nextSibling === anchor) return true;
    if (!node) {
      node = document.createElement('div');
      node.className = CLS;
      node.innerHTML = HTML;
    }
    anchor.parentNode.insertBefore(node, anchor);
    return true;
  }

  function run() {
    if (!place() || loaded) return;
    loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://news.google.com/swg/js/v1/publisher.js';
    document.head.appendChild(s);
  }

  run();
  if (document.body) {
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      run();
      new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
    });
  }
})();
</script>`;


// The homepage carries the button too, in the nav's left group so it is visible on
// load without scrolling. Same constraint as the blog posts and then some: the nav
// lives inside the Framer React root, so it is appended after hydration and held
// there by the observer. It is hidden below 1200px — the button is a fixed-width
// control and the nav collapses to a menu on smaller screens, where it would
// either overflow the row or crowd the burger.
const NAV_PREFERRED_SOURCE_CLASS = 'vaeral-nav-prefsrc';

const FOOT_PREFERRED_SOURCE_CLASS = 'vaeral-foot-prefsrc';
const MOB_PREFERRED_SOURCE_CLASS = 'vaeral-mob-prefsrc';

const NAV_PREFERRED_SOURCE_STYLES = `
<style>
  /* nav copy: pinned to the right edge and pulled a little past the row's
     gutter so it reads as the far-right control rather than a third item. */
  .${NAV_PREFERRED_SOURCE_CLASS} {
    flex: 0 0 auto; width: 238px; margin-left: auto; margin-right: -12px; line-height: 0;
  }
  /* Measured: the desktop nav row (links + Get Started) only activates at 1280px.
     From 1279px down the export switches to a logo-only burger nav and hides Get
     Started, so the button has no row to sit in and must hide with it. */
  @media (max-width: 1279px) {
    .${NAV_PREFERRED_SOURCE_CLASS} { display: none !important; }
  }

  /* mobile/tablet copy: the desktop nav button needs the desktop nav row, which
     the export drops below 1280px in favour of a collapsible menu. Rather than
     reach inside that menu, this sits just BELOW the nav bar and above the hero
     copy — visible on load without opening anything. Mirror image of the nav
     button's media query, so exactly one of the two ever shows. */
  .${MOB_PREFERRED_SOURCE_CLASS} {
    display: flex; justify-content: center; align-items: center;
    width: 100%; padding: 2px 20px 14px;
  }
  @media (min-width: 1280px) {
    .${MOB_PREFERRED_SOURCE_CLASS} { display: none !important; }
  }
  .${MOB_PREFERRED_SOURCE_CLASS} .btnwrap { width: 238px; max-width: 100%; }

  /* footer copy: centred on the page, in the band between the blog cards and the
     newsletter block. Measured: the Blog section has no bottom padding, so with
     no padding of its own the button collided with the cards while ~150px sat
     empty below it. The newsletter section contributes ~102px of its own top
     padding, so the space above is matched to that and the bottom left at 0 —
     which centres the button in the band instead of jamming it to the top. */
  .${FOOT_PREFERRED_SOURCE_CLASS} {
    display: flex; justify-content: center; align-items: center;
    gap: 22px; width: 100%; padding: 100px 24px 0;
  }
  .${FOOT_PREFERRED_SOURCE_CLASS} .copy { text-align: right; }
  .${FOOT_PREFERRED_SOURCE_CLASS} .cta {
    margin: 0; font-size: 15px; line-height: 1.45; color: #9b9bbd; max-width: 34ch;
  }
  .${FOOT_PREFERRED_SOURCE_CLASS} .nudge {
    margin: 5px 0 0; font-size: 13px; font-weight: 600; letter-spacing: 0.01em;
    color: rgb(197, 184, 255);
    display: flex; align-items: center; justify-content: flex-end; gap: 6px;
  }
  .${FOOT_PREFERRED_SOURCE_CLASS} .arw { font-size: 15px; line-height: 1; }
  .${FOOT_PREFERRED_SOURCE_CLASS} .btnwrap { width: 238px; max-width: 100%; }
  /* stacked on small screens: copy above the button, arrow turned to point at it */
  @media (max-width: 809px) {
    .${FOOT_PREFERRED_SOURCE_CLASS} {
      flex-direction: column; gap: 14px; padding: 56px 20px 8px;
    }
    .${FOOT_PREFERRED_SOURCE_CLASS} .copy { text-align: center; }
    .${FOOT_PREFERRED_SOURCE_CLASS} .cta { font-size: 14px; }
    .${FOOT_PREFERRED_SOURCE_CLASS} .nudge { justify-content: center; }
    .${FOOT_PREFERRED_SOURCE_CLASS} .arw { transform: rotate(90deg); }
  }

  /* Google sets min-height:60px inline on its mount but renders its ~46px pill at
     the TOP of that box, so the dead space below pushed the button above the row's
     centreline. Trimming the box to the pill's height lets align-items:center do
     its job. color-scheme keeps Chrome from painting an opaque backdrop behind
     the transparent iframe on this dark page. */
  .${NAV_PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn],
  .${MOB_PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn],
  .${FOOT_PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn] {
    min-height: 0 !important; height: 48px;
  }
  .${NAV_PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn] iframe,
  .${MOB_PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn] iframe,
  .${FOOT_PREFERRED_SOURCE_CLASS} [google-add-preferred-source-btn] iframe {
    color-scheme: normal;
  }
</style>`;

const NAV_PREFERRED_SOURCE_SCRIPT = `
<script>
(function () {
  var NAV_CLS = '${NAV_PREFERRED_SOURCE_CLASS}';
  var MOB_CLS = '${MOB_PREFERRED_SOURCE_CLASS}';
  var FOOT_CLS = '${FOOT_PREFERRED_SOURCE_CLASS}';
  var navNode = null;
  var mobNode = null;
  var footNode = null;
  var loaded = false;

  // Both mounts live inside the Framer React root, so they are added after
  // hydration and held by the observer. publisher.js scans for the attribute
  // once on load and does not re-scan, so it is loaded only after BOTH mounts
  // exist — otherwise the later one would never render.
  var mq = window.matchMedia('(min-width: 1280px)');

  function mount(cls, inner) {
    var d = document.createElement('div');
    d.className = cls;
    d.innerHTML = inner;
    return d;
  }

  var BTN = '<div google-add-preferred-source-btn data-theme="dark" data-lang="en"></div>';

  // The nav row is [logo + links][Get Started], laid out space-between. The
  // button becomes a third child at the end and the row is packed left, so
  // "Get Started" sits beside the links while margin-left:auto carries the
  // button to the right edge. The gap gives Contact and Get Started room to
  // breathe. Set inline rather than by class: the export's class names are
  // hashed and would not survive a re-export. Reverted below 1200px, where the
  // button is hidden.
  function layoutRow(row) {
    if (mq.matches) {
      row.style.justifyContent = 'flex-start';
      row.style.gap = '64px';
    } else {
      row.style.justifyContent = '';
      row.style.gap = '';
    }
  }

  function placeNav() {
    var grp = document.querySelector('[data-framer-name="Logo/Menu Items"]');
    var row = grp && grp.parentElement;
    if (!row) return false;
    layoutRow(row);
    if (navNode && navNode.parentNode === row && navNode === row.lastElementChild) return true;
    if (!navNode) navNode = mount(NAV_CLS, BTN);
    row.appendChild(navNode);
    return true;
  }

  // Below the nav bar, above the hero copy: the mobile/tablet stand-in for the
  // nav button. Both mounts are always created and CSS decides which is visible,
  // because publisher.js scans once on load — mounting on a breakpoint change
  // would leave a button that never renders.
  function placeMob() {
    var header = document.querySelector('[data-framer-name="Header web"]');
    if (!header || !header.parentNode) return false;
    if (!mobNode) mobNode = mount(MOB_CLS, '<div class="btnwrap">' + BTN + '</div>');
    var ord = getComputedStyle(header).order;
    if (ord && mobNode.style.order !== ord) mobNode.style.order = ord;
    if (mobNode.parentNode === header.parentNode && mobNode.previousSibling === header) return true;
    header.parentNode.insertBefore(mobNode, header.nextSibling);
    return true;
  }

  // Directly above the newsletter block that closes the page. Matched on its own
  // copy rather than a hashed class, so a re-export cannot silently move it — and
  // NOT on the variant name: the footer ships as Desktop/Tablet/Phone variants and
  // keying on "Desktop" dropped the button entirely below 1200px. The section is
  // the visible element that carries the copy and whose parent is an unnamed
  // wrapper; its inner Container/Newsletter boxes are skipped by that test.
  function newsletterBlock() {
    var els = document.querySelectorAll('[data-framer-name]');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (!/join newsletter/i.test(e.textContent || '')) continue;
      if (!e.getClientRects().length) continue;
      if (e.parentElement && e.parentElement.hasAttribute('data-framer-name')) continue;
      return e.parentNode && e.parentNode.parentNode ? e.parentNode : e;
    }
    return null;
  }

  var FOOT_INNER =
    '<div class="copy">' +
    '<p class="cta">Choose your sources before Google chooses for you.</p>' +
    '<p class="nudge">click me <span class="arw" aria-hidden="true">&#8594;</span></p>' +
    '</div>' +
    '<div class="btnwrap">' + BTN + '</div>';

  function placeFoot() {
    var block = newsletterBlock();
    if (!block || !block.parentNode) return false;
    if (!footNode) footNode = mount(FOOT_CLS, FOOT_INNER);
    // The page root is a flex column whose sections are REORDERED with CSS order
    // at narrow widths — measured on mobile: Top renders at 11948 while sitting
    // 5th in the DOM. A child with no order defaults to 0 and floats to the top
    // of the stack, which is why this button landed mid-page at 390px. Matching
    // the newsletter's order keeps it adjacent to it, and DOM order breaks the
    // tie so it stays ABOVE it.
    var ord = getComputedStyle(block).order;
    if (ord && footNode.style.order !== ord) footNode.style.order = ord;
    if (footNode.parentNode === block.parentNode && footNode.nextSibling === block) return true;
    block.parentNode.insertBefore(footNode, block);
    return true;
  }

  function loadLib() {
    if (loaded) return;
    loaded = true;
    if (document.querySelector('script[src*="news.google.com/swg"]')) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://news.google.com/swg/js/v1/publisher.js';
    document.head.appendChild(s);
  }

  function run() {
    var okNav = placeNav();
    var okMob = placeMob();
    var okFoot = placeFoot();
    if (okNav && okMob && okFoot) loadLib();
  }

  run();
  // If one anchor never turns up, still render the other rather than nothing.
  setTimeout(function () { if (navNode || mobNode || footNode) loadLib(); }, 4000);
  if (mq.addEventListener) mq.addEventListener('change', run);
  if (document.body) {
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      run();
      new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
    });
  }
})();
</script>`;

// Homepage: a "View all case studies" link under the case-study cards.
//
// The blog section has "View all posts" but the case-studies section had no equivalent, so the
// four cards on the homepage were the only route in — and three of the seven case studies are
// not among them, because the card set is fixed in the frozen export.
//
// The markup is CLONED from the existing "View all posts" element rather than hand-written, so
// the arrow icon, the classes and the text preset stay identical to it, and keep tracking it if
// the export is ever refreshed. Its classes are all scoped to .framer-7W2hy, which sits on the
// anchor itself, so they work wherever the element is placed.
function patchHomepageCaseStudiesCta(html) {
  const SOURCE_LABEL = 'View all posts';
  const NEW_LABEL = 'View all case studies';

  // Test for the element, not the label: the runtime script appended earlier contains both
  // label strings in its source, so a plain string check reports a false positive.
  if (html.includes(`class="${CS_CTA_CLASS}"`)) {
    throw new Error('homepage CTA: already inserted');
  }

  // Likewise anchored with the surrounding tag characters, so the needle cannot match the
  // label as it appears quoted inside that script.
  const at = html.indexOf(`>${SOURCE_LABEL}<`);
  if (at < 0) throw new Error(`homepage CTA: could not find "${SOURCE_LABEL}" element to clone`);
  const from = html.lastIndexOf('<a ', at);
  const to = html.indexOf('</a>', at);
  if (from < 0 || to < 0) throw new Error('homepage CTA: could not bound the source anchor');

  const cta = html
    .slice(from, to + 4)
    .replace(/href="[^"]*"/, 'href="/casestudies"')
    .split(SOURCE_LABEL)
    .join(NEW_LABEL);

  // Place it directly after the cards, still inside the section, so it reads as belonging to
  // them. The container end is found by matching div depth rather than by guessing at a string
  // in 74KB of minified export markup.
  const marker = '<div class="framer-fbd1z7" data-framer-name="cards">';
  const cardsAt = html.indexOf(marker);
  if (cardsAt < 0) throw new Error('homepage CTA: case-study cards container not found');

  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = cardsAt;
  let depth = 0;
  let cardsEnd = null;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m[1] === '') depth += 1;
    else if ((depth -= 1) === 0) {
      cardsEnd = tag.lastIndex;
      break;
    }
  }
  if (cardsEnd === null) throw new Error('homepage CTA: cards container never closes');

  const wrapped = `<div class="${CS_CTA_CLASS}" style="display:flex;justify-content:center;width:100%;padding:36px 0 0">${cta}</div>`;
  return html.slice(0, cardsEnd) + wrapped + html.slice(cardsEnd);
}

const CS_CTA_CLASS = 'vaeral-cs-cta';

// The static insert above is for crawlers, which read the served HTML. It does not survive in a
// browser: the homepage keeps its Framer runtime, and React's reconciliation drops the element on
// hydration — measured, the CTA count went to 0. This re-inserts it afterwards and keeps it there
// through later re-renders, the same approach NAV_SCRIPT uses for the nav hrefs it re-asserts.
//
// It clones the live "View all posts" element rather than carrying its own markup, so the arrow,
// classes and preset always match whatever the export currently ships. Both selectors it relies
// on are unique on the homepage (verified: one "cards" landmark, one "View all posts").
const CASE_STUDIES_CTA_SCRIPT = `
<script>
(function () {
  var CLS = '${CS_CTA_CLASS}';

  function labelOf(node) {
    return (node.textContent || '').trim();
  }

  function setLabel(node, text) {
    var els = node.querySelectorAll('p, span');
    for (var i = 0; i < els.length; i++) {
      if (els[i].childNodes.length === 1 && els[i].childNodes[0].nodeType === 3) {
        els[i].textContent = text;
        return true;
      }
    }
    return false;
  }

  function run() {
    if (document.querySelector('.' + CLS)) return;          // already there, nothing to do

    var cards = document.querySelector('[data-framer-name="cards"]');
    if (!cards || !cards.parentNode) return;

    var source = null;
    var links = document.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      if (labelOf(links[i]).indexOf('View all posts') === 0) { source = links[i]; break; }
    }
    if (!source) return;

    var clone = source.cloneNode(true);
    clone.setAttribute('href', '/casestudies');
    clone.setAttribute('target', '_top');
    if (!setLabel(clone, 'View all case studies')) return;   // markup changed; do not ship "posts"

    var wrap = document.createElement('div');
    wrap.className = CLS;
    wrap.setAttribute('style', 'display:flex;justify-content:center;width:100%;padding:36px 0 0');
    wrap.appendChild(clone);
    cards.parentNode.insertBefore(wrap, cards.nextSibling);
  }

  run();
  if (document.body) {
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      run();
      new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
    });
  }
})();
</script>`;

// "All case studies" button, shown under the content box on case-study pages only — the same
// template also builds the service pages and /about, where it would make no sense.
//
// The visual recipe is copied verbatim from the existing "Book a Free Audit" / "Get Started"
// primary buttons: same purple, radius, border, inset glow and text preset. Nothing new is
// designed here. Their layout class (.framer-1uvdw5m) could not be reused because it is scoped
// to .framer-cTzwY, the footer, so its exact declarations are reproduced in ALL_CASE_STUDIES_CSS
// instead of guessing at a size.
//
// No hover state, deliberately: the export has no CSS hover for these buttons — Framer drove it
// from the runtime that had to be removed in the hydration fix — so adding one here would make
// this the only button on the page that reacts.
// The label sits directly inside the <a>. The footer button wraps its label in a
// RichTextContainer, but that carries position:absolute, so the label contributes no width and
// the pill collapses to its padding (measured: 48px box, 119px of text spilling out). The <p>
// keeps the preset class and the colour token, so typography is identical without the wrapper.
const ALL_CASE_STUDIES_BUTTON = `<div class="vaeral-all-cs"><a class="vaeral-all-cs-btn" data-border="true" data-framer-name="Primary" href="/casestudies" style="--border-bottom-width:1px;--border-color:rgba(255, 255, 255, 0.15);--border-left-width:1px;--border-right-width:1px;--border-style:solid;--border-top-width:1px;background-color:rgb(81, 55, 250);border-bottom-left-radius:12px;border-bottom-right-radius:12px;border-top-left-radius:12px;border-top-right-radius:12px;box-shadow:inset 0px 0px 20px 0px rgba(255, 255, 255, 0.2)"><p class="framer-text framer-styles-preset-hj0x3x" data-styles-preset="G4spYZp3J" dir="auto" style="--framer-text-color:var(--token-05f7c79d-9f6d-455d-9542-2f5b1e17e42e, rgb(222, 221, 255))">All case studies</p></a></div>`;

// Named for tables historically; now carries every structural rule the frozen export lacks
// for CMS-authored content (tables, code blocks). Colour always comes from the presets.
function injectContentStyles(html) {
  if (!html.includes('</head>')) throw new Error('injectContentStyles: no </head> found');
  return html.replace('</head>', CONTENT_STYLES);
}

const IMAGE_SCRIPT = `
<script>
(function(){
  const observer = new MutationObserver(() => {
    document.querySelectorAll('img[width="608"][height="698"]').forEach(img => {
      if(!img.src.includes('/assets/robot_nodes.png')) {
        img.src = '/assets/robot_nodes.png';
        img.removeAttribute('srcset');
      }
    });
    document.querySelectorAll('img[width="820"][height="415"]').forEach(img => {
      if(!img.src.includes('/assets/negative_post.png')) {
        img.src = '/assets/negative_post.png';
        img.removeAttribute('srcset');
      }
    });
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  } else {
    document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] }));
  }
})();
</script>
`;

function patchImages(html) {
  const replace1 = `<img decoding="async" width="608" height="698" sizes="(min-width: 1280px) 363px, (max-width: 809.98px) 301px, (min-width: 810px) and (max-width: 1279.98px) 239px" src="/assets/robot_nodes.png" alt style="display:block;width:100%;height:100%;border-radius:inherit;corner-shape:inherit;object-position:center;object-fit:contain">`;
  const replace2 = `<img decoding="async" width="820" height="415" sizes="(min-width: 1280px) 711px, (min-width: 810px) and (max-width: 1279.98px) 711px, (max-width: 809.98px) 637px" src="/assets/negative_post.png" alt style="display:block;width:100%;height:100%;border-radius:inherit;corner-shape:inherit;object-position:center;object-fit:cover">`;
  let out = html.replace(/<img[^>]+width="608"[^>]+height="698"[^>]+src="data:image\/svg[^>]+>/g, replace1);
  out = out.replace(/<img[^>]+width="820"[^>]+height="415"[^>]+src="data:image\/svg[^>]+>/g, replace2);
  return out.replace('</body>', `${IMAGE_SCRIPT}</body>`);
}

function writePage(dir, html) {
  fs.mkdirSync(dir, { recursive: true });
  // Nav anchors are relative in the Framer export and resolve against the current
  // page, which breaks them everywhere except the homepage. Rewrite to absolute,
  // and re-assert at runtime since hydration reverts DOM changes.
  const patched = hasFramerNav(html)
    ? patchNavHrefs(html).replace('</body>', `${NAV_SCRIPT}</body>`)
    : html;
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    patchImages(patched.replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com')),
  );
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readMarkdownDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const { attributes, body } = fm(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { file: f, attributes, body };
    });
}

// --- Framer text-preset re-emission ---------------------------------------
//
// Rich fields empty their Framer container, so marked's plain <p>/<ul>/... output
// would lose the Framer .framer-text presets (and, for case studies, the light text
// color it needs to be legible on the dark section background). We re-apply the exact
// preset classes/styles captured from the live export so injected body markup matches.

const CASE_COLOR = '--framer-text-color:var(--token-05f7c79d-9f6d-455d-9542-2f5b1e17e42e, rgb(222, 221, 255))';
const BLOG_COLOR = 'color:rgb(222, 221, 255) !important;--framer-text-color:rgb(222, 221, 255)';

const BLOG_PRESETS = {
  p: { class: 'framer-text framer-styles-preset-dg89m0' },
  h2: { class: 'framer-text framer-styles-preset-398jw4', wrapStrong: true },
  h3: { class: 'framer-text framer-styles-preset-1tx2fj3', wrapStrong: true },
  h4: { class: 'framer-text framer-styles-preset-1t2dmrb', wrapStrong: true },
  h5: { class: 'framer-text framer-styles-preset-1t2dmrb', wrapStrong: true },
  h6: { class: 'framer-text framer-styles-preset-1t2dmrb', wrapStrong: true },
  a: { class: 'framer-text framer-styles-preset-s7x4xb', attrs: { target: '_blank', rel: 'noopener' } },
  strong: { class: 'framer-text', style: BLOG_COLOR },
  em: { class: 'framer-text', style: BLOG_COLOR },
  ul: { class: 'framer-text', style: BLOG_COLOR },
  ol: { class: 'framer-text', style: BLOG_COLOR },
  li: { class: 'framer-text framer-styles-preset-dg89m0', attrs: { 'data-preset-tag': 'p' }, style: BLOG_COLOR, innerPClass: 'framer-text framer-styles-preset-dg89m0', innerPStyle: BLOG_COLOR },
  blockquote: { class: 'framer-text framer-styles-preset-dg89m0' },
  table: { class: 'framer-text' },
  th: { class: 'framer-text framer-styles-preset-dg89m0' },
  td: { class: 'framer-text framer-styles-preset-dg89m0' },
  del: { class: 'framer-text framer-styles-preset-dg89m0' },
  code: { class: 'framer-text framer-styles-preset-dg89m0' },
  pre: { class: 'framer-text framer-styles-preset-dg89m0' },
};

const CASE_PRESETS = {
  p: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  h2: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR, wrapStrong: true },
  h3: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR, wrapStrong: true },
  h4: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR, wrapStrong: true },
  a: { class: 'framer-text', attrs: { target: '_blank', rel: 'noopener' } },
  strong: { class: 'framer-text' },
  em: { class: 'framer-text' },
  ul: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  ol: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  li: { class: 'framer-text', attrs: { 'data-preset-tag': 'p' }, innerPClass: null, innerPStyle: CASE_COLOR },
  blockquote: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  // Tables were never in this map because no case study used one until the on-demand
  // services study. Without the preset class the cells miss --framer-text-color and
  // render near-black on the dark section background: in the DOM, invisible on screen.
  table: { class: 'framer-text', style: CASE_COLOR },
  th: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  td: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  // h5/h6, code, pre and del were missing too. Measured in a real browser, each rendered
  // rgb(0,0,0) on a near-black background — an editor writing a code snippet or an H5
  // shipped invisible text, exactly as the table did. Same treatment as the other tags.
  h5: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR, wrapStrong: true },
  h6: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR, wrapStrong: true },
  del: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  code: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
  pre: { class: 'framer-text framer-styles-preset-hj0x3x', attrs: { 'data-styles-preset': 'G4spYZp3J', dir: 'auto' }, style: CASE_COLOR },
};

// Tags that carry no text of their own, so they need no colour preset. Everything else an
// editor can produce must be in the preset map, or it inherits its colour and renders
// black-on-black on these dark templates. That is how the results table shipped invisible:
// nothing was wrong with the markup, it simply had no rule matching it.
//
// Failing the build is deliberate. The alternative — styling whatever we happen to think of
// and discovering the rest in production — is the loop this exists to end. If this throws,
// add the tag to BLOG_PRESETS and CASE_PRESETS rather than to the exempt list, unless the
// tag genuinely renders no text.
const PRESET_EXEMPT = new Set([
  'thead', 'tbody', 'tfoot', 'tr', 'br', 'hr', 'img', 'picture', 'source', 'span', 'div',
  'figure', 'figcaption', 'iframe', 'video', 'sup', 'sub',
]);

function assertPresetCoverage($, presets, label) {
  const missing = new Set();
  $('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (!tag || PRESET_EXEMPT.has(tag) || presets[tag]) return;
    missing.add(tag);
  });
  if (missing.size) {
    throw new Error(
      `${label}: produced <${[...missing].sort().join('>, <')}> with no preset entry. ` +
        'Unstyled tags inherit their colour and render invisibly on these templates. Add them to ' +
        'BLOG_PRESETS/CASE_PRESETS (or to PRESET_EXEMPT if the tag renders no text of its own).',
    );
  }
}

function restyle(html, presets, label = 'CMS content') {
  if (!html || !html.trim()) return '';
  const $ = cheerio.load(html, cheerioOpts, false);
  assertPresetCoverage($, presets, label);

  // Framer wraps each list item's content in a <p>; marked only does so for "loose"
  // lists. Normalise so every <li> has an inner <p> we can style.
  if (presets.li) {
    $('li').each((_, el) => {
      const $li = $(el);
      if ($li.children('p').length === 0) $li.html(`<p>${$li.html()}</p>`);
    });
  }

  const order = ['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'th', 'td', 'a', 'strong', 'em'];
  for (const tag of order) {
    const cfg = presets[tag];
    if (!cfg) continue;
    const sel = tag === 'p' ? $('p').not('li > p') : $(tag);
    sel.each((_, el) => {
      const $el = $(el);
      if (cfg.wrapStrong) $el.html(`<strong class="framer-text">${$el.html()}</strong>`);
      if (cfg.class !== undefined) $el.attr('class', cfg.class);
      if (cfg.attrs) for (const [k, v] of Object.entries(cfg.attrs)) $el.attr(k, v);
      if (cfg.style !== undefined) $el.attr('style', cfg.style);
    });
  }

  // Style the inner <p> Framer expects inside each list item.
  if (presets.li && (presets.li.innerPClass !== undefined || presets.li.innerPStyle)) {
    $('li > p').each((_, el) => {
      const $p = $(el);
      if (presets.li.innerPClass) $p.attr('class', presets.li.innerPClass);
      else if (presets.li.innerPClass === null) $p.removeAttr('class');
      if (presets.li.innerPStyle) $p.attr('style', presets.li.innerPStyle);
    });
  }

  return $.html();
}

// --- Framer rich-text AST (blog handover hydration) ------------------------
//
// Blog pages are Framer CMS-collection pages: the runtime (script_main.mjs) hydrates
// and re-renders title/date/read-time/body from an embedded CMS record in the
// <script type="framer/handover"> island, overwriting the SSR DOM we injected. So a
// post built from a shared template would show the TEMPLATE post's content after JS runs.
// We therefore also rewrite that record. The body is stored as Framer's rich-text AST:
//   element  -> [4, "tag", attrsObjOrNull, ...children]
//   text     -> [5, "text"]
//   document -> [1, ...blockNodes]
// Blocks carry {"dir":"auto"}; headings wrap content in <strong>; NO Framer classes
// (the RichText component applies presets on render). (Case-study pages are static —
// their handover has no body — so they need no such patch.)

const AST_BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote']);
const AST_HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function nodeToAst($, el) {
  if (el.type === 'text') {
    if (/^\s*$/.test(el.data)) return null; // drop formatting whitespace between blocks
    return [5, el.data];
  }
  if (el.type !== 'tag') return null;
  const tag = el.name;
  if (tag === 'br') return [4, 'br', null];

  let kids = [];
  for (const c of el.children || []) {
    const a = nodeToAst($, c);
    if (a) kids.push(a);
  }
  if (AST_HEADING.has(tag)) kids = [[4, 'strong', null, ...kids]];

  let attrs;
  if (AST_BLOCK.has(tag)) attrs = { dir: 'auto' };
  else if (tag === 'a') attrs = { href: $(el).attr('href') || '', rel: 'noopener', target: '_blank' };
  else attrs = null;

  return [4, tag, attrs, ...kids];
}

function mdToFramerBody(markdown) {
  const $ = cheerio.load(marked.parse(markdown || '')); // default decodeEntities -> real chars
  const blocks = [];
  $('body').contents().each((_, el) => {
    const a = nodeToAst($, el);
    if (a) blocks.push(a);
  });
  return JSON.stringify([1, ...blocks]);
}

// Positional value indices in templates/blog.html's handover (current-record fields).
// Cover image is a responsiveimage object: {src:16, srcSet:17, pixelWidth:18, pixelHeight:19, alt:20}.
const HANDOVER = { TITLE: 7, DESCRIPTION: 9, DATE: 12, READTIME: 22, BODY: 27,
  IMG_SRC: 16, IMG_SRCSET: 17, IMG_W: 18, IMG_H: 19, IMG_ALT: 20 };

function patchBlogHandover(html, a, body, hero) {
  const re = /(<script[^>]*id="__framer__handoverData"[^>]*>)([\s\S]*?)(<\/script>)/;
  if (!re.test(html)) throw new Error('blog handover island not found in template');
  return html.replace(re, (_m, open, json, close) => {
    const arr = JSON.parse(json);
    // Fail loudly if the template's handover layout drifts — never silently corrupt.
    const shapeOk =
      arr[6] === 'string' && arr[11] === 'date' && arr[14] === 'responsiveimage' &&
      arr[24] === 'richtext' &&
      typeof arr[HANDOVER.BODY] === 'string' && arr[HANDOVER.BODY].startsWith('[1,');
    if (!shapeOk) throw new Error('blog handover layout changed — re-map HANDOVER indices in build.js');
    arr[HANDOVER.TITLE] = a.title;
    arr[HANDOVER.DESCRIPTION] = a.description;
    arr[HANDOVER.DATE] = isoDate(a.date);
    arr[HANDOVER.READTIME] = readTimeLabel(a, body);
    arr[HANDOVER.BODY] = mdToFramerBody(body);
    // Cover image (so hydration doesn't re-assert the template post's hero photo).
    arr[HANDOVER.IMG_SRC] = hero.src;
    arr[HANDOVER.IMG_SRCSET] = hero.src; // single local file, no responsive variants
    arr[HANDOVER.IMG_W] = hero.width;
    arr[HANDOVER.IMG_H] = hero.height;
    arr[HANDOVER.IMG_ALT] = hero.alt;
    return open + JSON.stringify(arr) + close;
  });
}

// --- tag chips (byte-exact Framer prototype, text swapped) -----------------

let _chipProtos = null;
function chipPrototypes() {
  if (_chipProtos) return _chipProtos;
  const $ = cheerio.load(fs.readFileSync(CHIP_SOURCE, 'utf8'), cheerioOpts);
  _chipProtos = $('[data-framer-name="Highlights"]')
    .first()
    .children()
    .map((_, el) => $.html(el))
    .get();
  return _chipProtos;
}

function renderChips(tags) {
  const protos = chipPrototypes();
  if (!protos.length) return '';
  return (tags || [])
    .map((tag, i) => {
      const $ = cheerio.load(protos[i % protos.length], cheerioOpts, false);
      $('p.framer-text').first().text(String(tag));
      return $.html();
    })
    .join('');
}

// --- builders --------------------------------------------------------------

// The "Read More Blogs" card was hardcoded to one post in the Framer export, which
// caused three bugs: it recommended the post you were already reading, it never
// varied, and its href was relative — so from /blog/viral-negative/ it resolved to
// /blog/viral-negative/using-reddit-marketing and returned a 404 in production.
//
// Picks the most recent other published post. The module has room for one card, so
// with two posts published there is exactly one candidate; this generalises as more
// are added.
function pickRelatedPost(current, allPosts) {
  const others = allPosts
    .filter((p) => p.attributes.slug !== current.slug && !p.attributes.draft)
    .sort((x, y) => toDate(y.attributes.date) - toDate(x.attributes.date));
  return others[0] || null;
}

function buildBlogPost({ attributes: a, body }, allPosts = []) {
  const url = `${SITE}/blog/${a.slug}`;
  const hero = { src: a.coverImage || '/assets/og-image.png', alt: a.coverAlt || a.title, ...imageSize(a.coverImage) };
  const relatedEntry = pickRelatedPost(a, allPosts);
  const related = relatedEntry
    ? {
        href: `/blog/${relatedEntry.attributes.slug}`,
        title: relatedEntry.attributes.title,
        date: fmtDate(relatedEntry.attributes.date),
        readTime: readTimeLabel(relatedEntry.attributes, relatedEntry.body || ''),
      }
    : // Only one post published: send readers to the index rather than to itself.
      { href: '/blog', title: 'More from the Vaeral blog', date: '', readTime: '' };
  let html = fill(fs.readFileSync(path.join(TEMPLATES, 'blog.html'), 'utf8'), {
    TITLE: escapeHtml(a.title),
    SEO_TITLE: escapeHtml(a.seoTitle || a.title),
    DESCRIPTION: escapeHtml(a.description),
    OG_IMAGE: escapeHtml(absImage(a.coverImage)),
    URL: escapeHtml(url),
    DATE: escapeHtml(fmtDate(a.date)),
    DATETIME: escapeHtml(isoDate(a.date)),
    READTIME: escapeHtml(readTimeLabel(a, body)),
    HERO_SRC: escapeHtml(hero.src),
    HERO_ALT: escapeHtml(hero.alt),
    HERO_W: String(hero.width),
    HERO_H: String(hero.height),
    RELATED_HREF: escapeHtml(related.href),
    RELATED_TITLE: escapeHtml(related.title),
    RELATED_DATE: escapeHtml(related.date),
    RELATED_READTIME: escapeHtml(related.readTime),
    // FAQs (optional) render into the body from the same frontmatter that feeds the
    // schema, so the visible Q&A and the structured data cannot drift apart.
    BODY: restyle(marked.parse(body), BLOG_PRESETS, `blog/${a.slug} body`) + renderFaqs(a.faqs, BLOG_PRESETS),
    JSONLD: schema.renderJsonLd([
      a.faqs && a.faqs.length ? schema.faqPage(a.faqs) : null,
      schema.blogPosting({
        site: SITE,
        url,
        image: absImage(a.coverImage),
        attrs: {
          title: a.title,
          description: a.description,
          datePublished: isoDate(a.date),
          dateModified: isoDate(a.date),
          keywords: Array.isArray(a.tags) ? a.tags : [],
        },
      }),
      schema.breadcrumbList([
        { name: 'Home', url: `${SITE}/` },
        { name: 'Blog', url: `${SITE}/blog` },
        { name: a.title, url },
      ]),
      schema.speakablePage({ url }),
    ]),
  });
  // Blog posts are articles, not generic pages. The Framer export hardcodes
  // og:type=website on every page; article + the article:* fields give social
  // platforms and answer engines the publish/update dates explicitly.
  html = html.replace(
    /<meta property="og:type" content="website">/i,
    [
      '<meta property="og:type" content="article">',
      `<meta property="article:published_time" content="${escapeHtml(isoDate(a.date))}">`,
      `<meta property="article:modified_time" content="${escapeHtml(isoDate(a.date))}">`,
    ].join('\n    '),
  );

  // Also rewrite the Framer CMS record so client hydration renders this post, not the template's.
  html = patchBlogHandover(html, a, body, hero);
  
  // Inject CSS to disable the sticky scroll effect on the Newsletter box
  html = html.replace('</head>', `
<style>
  .framer-text li,
  .framer-text li strong,
  .framer-text strong {
    color: rgb(222, 221, 255) !important;
  }
  @media (min-width: 1280px) {
    .framer-1q32mfl {
      position: relative !important;
      top: 0 !important;
    }
  }
</style>
</head>`);

  // Table styles only; blog.html keeps its Framer runtime (it hydrates in place). No post
  // uses a table today — this is here so the first one that does renders, rather than
  // reproducing the invisible-table bug the case studies just hit.
  html = injectContentStyles(disableSPARouting(html));
  html = html.replace('</body>', () => PREFERRED_SOURCE_STYLES + PREFERRED_SOURCE_SCRIPT + '</body>');
  writePage(path.join(DIST, 'blog', a.slug), html);
  return {
    slug: a.slug,
    title: a.title,
    date: a.date,
    description: a.description,
    coverImage: a.coverImage,
    readTime: readTimeLabel(a, body),
  };
}

function buildCaseStudy({ attributes: a }) {
  const url = `${SITE}/${a.slug}`;
  let html = fill(fs.readFileSync(path.join(TEMPLATES, 'case-study.html'), 'utf8'), {
    TITLE: escapeHtml(a.title),
    SEO_TITLE: escapeHtml(a.seoTitle || a.title),
    DESCRIPTION: escapeHtml(a.description),
    OG_IMAGE: escapeHtml(absImage(a.coverImage)),
    URL: escapeHtml(url),
    CATEGORY: escapeHtml(a.category),
    TAGS: renderChips(a.tags),
    // Defaults preserve the headings that were hardcoded in the Framer export,
    // so existing case studies render byte-identically after the template was
    // parameterised for reuse by service pages.
    SECTION_1_HEADING: escapeHtml(a.sectionOneHeading || 'The Problem'),
    SECTION_2_HEADING: escapeHtml(a.sectionTwoHeading || 'What We Did'),
    SECTION_3_HEADING: escapeHtml(a.sectionThreeHeading || 'The Results'),
    ALL_CASE_STUDIES: ALL_CASE_STUDIES_BUTTON,
    // "Go back" belongs to the listing this page came from, not the homepage.
    BACK_HREF: '/casestudies',
    PROBLEM: restyle(marked.parse(a.problem || ''), CASE_PRESETS, `case-study/${a.slug} "The Problem"`),
    WHATWEDID: restyle(marked.parse(a.whatWeDid || ''), CASE_PRESETS, `case-study/${a.slug} "What We Did"`),
    RESULTS: restyle(marked.parse(a.results || ''), CASE_PRESETS, `case-study/${a.slug} "The Results"`),
    JSONLD: schema.renderJsonLd([
      schema.caseStudyArticle({
        site: SITE,
        url,
        image: absImage(a.coverImage),
        attrs: {
          title: a.title,
          description: a.description,
          category: a.category,
          datePublished: isoDate(a.date),
          dateModified: isoDate(a.date),
        },
      }),
      schema.breadcrumbList([
        { name: 'Home', url: `${SITE}/` },
        { name: 'Case Studies', url: `${SITE}/casestudies` },
        { name: a.title, url },
      ]),
    ]),
  });
  html = injectInteractionStyles(injectContentStyles(patchRelativeHomeLinks(stripFramerPageRuntime(disableSPARouting(html)))));
  writePage(path.join(DIST, a.slug), html);
  return { 
    slug: a.slug, 
    title: a.title, 
    description: a.description, 
    coverImage: a.coverImage, 
    category: a.category, 
    date: a.date 
  };
}

// Service content already stores its workflow as Markdown headings. Reuse those
// visible steps for HowTo instead of maintaining a second copy in frontmatter.
function deriveHowToSteps(markdown) {
  if (!markdown) return [];
  const steps = [];
  const headingPattern = /^###\s+(.+?)\s*$([\s\S]*?)(?=^###\s+|(?![\s\S]))/gim;
  for (const match of markdown.matchAll(headingPattern)) {
    const text = match[2]
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\*\*|__|`/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    if (text) steps.push({ name: match[1].trim(), text });
  }
  return steps;
}

// Service pages and /about reuse the case-study shell rather than introducing new
// UI. Same three rich-text regions, with the section headings supplied by
// frontmatter instead of defaulting to the case-study wording.
function buildStandardPage({ attributes: a }, { dir, breadcrumbParent, schemaType }) {
  const url = `${SITE}/${dir ? `${dir}/` : ''}${a.slug}`;
  const faqHtml = renderFaqs(a.faqs);
  const howToSteps = Array.isArray(a.howToSteps) && a.howToSteps.length
    ? a.howToSteps
    : deriveHowToSteps(a.sectionTwo);

  let html = fill(fs.readFileSync(path.join(TEMPLATES, 'case-study.html'), 'utf8'), {
    TITLE: escapeHtml(a.title),
    SEO_TITLE: escapeHtml(a.seoTitle || a.title),
    DESCRIPTION: escapeHtml(a.description),
    OG_IMAGE: escapeHtml(absImage(a.coverImage)),
    URL: escapeHtml(url),
    CATEGORY: escapeHtml(a.category || ''),
    TAGS: renderChips(a.tags),
    SECTION_1_HEADING: escapeHtml(a.sectionOneHeading || ''),
    SECTION_2_HEADING: escapeHtml(a.sectionTwoHeading || ''),
    SECTION_3_HEADING: escapeHtml(a.sectionThreeHeading || ''),
    // Service pages and /about share this template but are not case studies, so the button is
    // filled with nothing rather than left unfilled — an unfilled marker survives into the HTML.
    ALL_CASE_STUDIES: '',
    // Service pages go back to /services; /about has no listing above it, so it goes home.
    BACK_HREF: dir ? `/${dir}` : '/',
    PROBLEM: restyle(marked.parse(a.sectionOne || ''), CASE_PRESETS, `${a.slug} section 1`),
    WHATWEDID: restyle(marked.parse(a.sectionTwo || ''), CASE_PRESETS, `${a.slug} section 2`),
    // The FAQ renders inside the third region so the questions are visible page
    // copy — FAQPage schema without visible Q&A breaches Google's policy.
    RESULTS: restyle(marked.parse(a.sectionThree || ''), CASE_PRESETS, `${a.slug} section 3`) + faqHtml,
    JSONLD: schema.renderJsonLd([
      schemaType === 'Service'
        ? schema.service({
            site: SITE,
            url,
            image: absImage(a.coverImage),
            attrs: {
              title: a.title,
              description: a.description,
              serviceType: a.category || a.title,
              keywords: Array.isArray(a.tags) ? a.tags : [],
            },
          })
        : schemaType === 'AboutPage'
        ? schema.aboutPage({
            site: SITE,
            url,
            attrs: a,
          })
        : schema.caseStudyArticle({
            site: SITE,
            url,
            image: absImage(a.coverImage),
            attrs: {
              title: a.title,
              description: a.description,
              category: a.category,
              datePublished: isoDate(a.date),
              dateModified: isoDate(a.date),
            },
            type: schemaType,
          }),
      schemaType === 'AboutPage' ? schema.person(SITE) : null,
      a.faqs && a.faqs.length ? schema.faqPage(a.faqs) : null,
      schemaType === 'Service'
        ? schema.howTo({
            name: `How ${a.title} Works`,
            description: a.description,
            steps: howToSteps,
          })
        : null,
      schema.breadcrumbList(
        [
          { name: 'Home', url: `${SITE}/` },
          breadcrumbParent,
          { name: a.title, url },
        ].filter(Boolean),
      ),
      schemaType === 'Service' ? schema.speakablePage({ url }) : null,
    ].filter(Boolean)),
  });

  html = injectInteractionStyles(injectContentStyles(patchRelativeHomeLinks(stripFramerPageRuntime(disableSPARouting(html)))));
  writePage(path.join(DIST, ...(dir ? [dir] : []), a.slug), html);
  // `category` is the short label ("Comment Management") as opposed to the full page title
  // ("Comment Management for Social and Community Platforms"). The homepage services grid needs
  return { slug: a.slug, title: a.title, description: a.description, category: a.category, date: a.date, url };
}

// FAQ answers come from frontmatter so the visible copy and the schema share one
// source — two sources here would drift and eventually breach the policy above.
function renderFaqs(faqs, presets = CASE_PRESETS) {
  if (!faqs || !faqs.length) return '';
  const items = faqs
    .map(
      ({ question, answer }) =>
        `<h3>${escapeHtml(question)}</h3>\n<p>${escapeHtml(answer)}</p>`,
    )
    .join('\n');
  return restyle(`<h2>Frequently asked questions</h2>\n${items}`, presets, 'FAQ answers');
}

function caseStudyCard(p) {
  const cover = absImage(p.coverImage).replace(SITE, '');
  return `    <a class="card" href="/${p.slug}">
      <img class="cover" src="${escapeHtml(cover)}" alt="${escapeHtml(p.title)}" loading="lazy">
      <div class="body">
        <div class="meta"><span>${escapeHtml(p.category || 'Case Study')}</span></div>
        <h2>${escapeHtml(p.title)}</h2>
        <p class="excerpt">${escapeHtml(p.description)}</p>
        <span class="more">Read case study &rarr;</span>
      </div>
    </a>`;
}

function buildCaseStudyIndex(cases) {
  const ordered = [...cases].sort((a, b) => toDate(b.date) - toDate(a.date));
  const cards = ordered.length
    ? ordered.map(caseStudyCard).join('\n')
    : '    <p class="empty">No case studies published yet.</p>';
  let html = fill(fs.readFileSync(path.join(TEMPLATES, 'case-study-index.html'), 'utf8'), {
    TITLE: escapeHtml('ORM Case Studies: Reddit & Quora Results | Vaeral'),
    H1: 'Case Studies',
    DESCRIPTION: escapeHtml('Explore our portfolio of successful projects and case studies.'),
    URL: escapeHtml(`${SITE}/casestudies`),
    CASES: cards,
    JSONLD: schema.renderJsonLd(
      schema.breadcrumbList([
        { name: 'Home', url: `${SITE}/` },
        { name: 'Case Studies', url: `${SITE}/casestudies` },
      ]),
    ),
  });
  writePage(path.join(DIST, 'casestudies'), disableSPARouting(html));
}

// The /services hub. Reuses the case-study index template rather than adding new
// UI, and gives the service-page breadcrumbs a real parent to point at instead of
// a 404.
function buildServiceIndex(services) {
  const cards = services.length
    ? services
        .map(
          (s) => `    <a class="card" href="/services/${s.slug}">
      <div class="body">
        <div class="meta"><span>Service</span></div>
        <h2>${escapeHtml(s.title)}</h2>
        <p class="excerpt">${escapeHtml(s.description)}</p>
        <span class="more">Read more &rarr;</span>
      </div>
    </a>`,
        )
        .join('\n')
    : '    <p class="empty">No services published yet.</p>';

  // Deliberately names no services and no count. The previous version enumerated six, which
  // stopped being true the moment a seventh page shipped; a count would go stale the same way
  // at eleven. This is the one string here that must survive the service list changing.
  const description =
    'Reputation, search visibility and growth services — what each one covers, who it suits, and who it does not.';

  const html = fill(fs.readFileSync(path.join(TEMPLATES, 'case-study-index.html'), 'utf8'), {
    TITLE: escapeHtml('ORM, Search and Growth Services | Vaeral'),
    // The shared index template hardcoded "Case Studies", so /services carried the wrong
    // visible heading while its title tag was correct. Marker-driven per page now.
    H1: 'Services',
    DESCRIPTION: escapeHtml(description),
    URL: escapeHtml(`${SITE}/services`),
    CASES: cards,
    JSONLD: schema.renderJsonLd([
      schema.breadcrumbList([
        { name: 'Home', url: `${SITE}/` },
        { name: 'Services', url: `${SITE}/services` },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: services.map((s, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: s.title,
          url: s.url,
        })),
      },
    ]),
  });
  writePage(path.join(DIST, 'services'), disableSPARouting(html));
}

function blogCard(p) {
  const cover = absImage(p.coverImage).replace(SITE, '');
  return `    <a class="card" href="/blog/${p.slug}">
      <img class="cover" src="${escapeHtml(cover)}" alt="${escapeHtml(p.title)}" loading="lazy">
      <div class="body">
        <div class="meta"><span>${escapeHtml(fmtDate(p.date))}</span><span class="dot"></span><span>${escapeHtml(p.readTime)}</span></div>
        <h2>${escapeHtml(p.title)}</h2>
        <p class="excerpt">${escapeHtml(p.description)}</p>
        <span class="more">Read article &rarr;</span>
      </div>
    </a>`;
}

function buildBlogIndex(posts) {
  const ordered = [...posts].sort((a, b) => toDate(b.date) - toDate(a.date));
  const cards = ordered.length
    ? ordered.map(blogCard).join('\n')
    : '    <p class="empty">No posts published yet.</p>';
  let html = fill(fs.readFileSync(path.join(TEMPLATES, 'blog-index.html'), 'utf8'), {
    TITLE: escapeHtml('ORM, Reddit & AI Search Insights | Vaeral Blog'),
    URL: escapeHtml(`${SITE}/blog`),
    POSTS: cards,
    JSONLD: schema.renderJsonLd(
      schema.breadcrumbList([
        { name: 'Home', url: `${SITE}/` },
        { name: 'Blog', url: `${SITE}/blog` },
      ]),
    ),
  });
  writePage(path.join(DIST, 'blog'), disableSPARouting(html));
}

// --- navigation ---------------------------------------------------------------

// The nav shipped as homepage anchors (./#about, ./#casestudies), which means the
// real /about and /services pages get no link equity and the nav is useless from
// any page other than the homepage. These rewrite the static markup so crawlers
// see real routes without executing JS; NAV_SCRIPT below re-asserts them for users
// after React hydration, which would otherwise revert the change.
//
// #contact stays an anchor deliberately: the working contact form lives on the
// homepage and there is no /contact page yet.
// The relative forms are also a live bug on every non-homepage page: from
// /services/reddit-marketing/, href="./#about" resolves to
// /services/reddit-marketing/#about — a section that does not exist there. Case
// studies and blog posts have shipped with this broken nav. Absolute paths fix
// navigation sitewide and are what crawlers follow.
//
// #contact stays an anchor because the working contact form lives on the homepage
// and there is no /contact page yet — but it must be absolute (/#contact) off the
// homepage, or it points at a fragment of whatever page you are on.
const NAV_ROUTES = [
  { anchors: ['./#about', '../#about'], to: '/about' },
  { anchors: ['./#casestudies', '../#casestudies'], to: '/casestudies' },
  { anchors: ['../#contact'], to: '/#contact' },
];

// On the homepage './#contact' is a genuine same-page anchor and is left alone;
// elsewhere it has to become absolute.
function hasFramerNav(html) {
  return html.includes('<nav');
}

function patchNavHrefs(html, { isHomepage = false } = {}) {
  // The listing pages (services / casestudies / blog index) are plain templates
  // with no Framer nav, so there is nothing to rewrite and nothing to assert.
  if (!hasFramerNav(html)) return html;

  let touched = 0;
  const routes = isHomepage
    ? NAV_ROUTES
    : [...NAV_ROUTES, { anchors: ['./#contact'], to: '/#contact' }];

  for (const { anchors, to } of routes) {
    for (const from of anchors) {
      const needle = `href="${from}"`;
      if (!html.includes(needle)) continue;
      html = html.split(needle).join(`href="${to}"`);
      touched++;
    }
  }

  // A Framer page with a nav but no recognised anchors means the export changed —
  // fail loudly rather than silently shipping a nav that goes nowhere.
  if (!touched) {
    throw new Error('page has a nav but no known anchors to rewrite — export changed');
  }
  return html;
}

// Replaces the previous approach, which cloned the Contact link on a 500ms
// setInterval that ran forever. This uses a MutationObserver instead, is
// idempotent, and adds Services alongside Blogs.
const NAV_SCRIPT = `
<script>
(function () {
  var EXTRA = [
    { cls: 'vaeral-services-link', label: 'Services', href: '/services' },
    { cls: 'vaeral-blogs-link', label: 'Blogs', href: '/blog' }
  ];
  // 'Portfolio' is the label Framer ships for the case-studies link. It was missing from this
  // map, so the re-assertion never matched it and hydration reverted its href to the original
  // './#casestudies' — an on-page anchor. Clicking it did not reach /casestudies at all.
  var ROUTES = { 'About': '/about', 'Case Studies': '/casestudies', 'Portfolio': '/casestudies' };

  // The page it leads to is titled "Case Studies", and every other reference on the site uses
  // that wording, so the nav should say it too. Relabelling rather than adding a second item:
  // two nav links to one URL is worse than one that is named accurately. Idempotent — once
  // relabelled the entry matches ROUTES['Case Studies'] and RELABEL no longer applies.
  var RELABEL = { 'Portfolio': 'Case Studies' };

  function labelOf(node) {
    return (node.textContent || '').trim();
  }

  function setLabel(node, text) {
    var spans = node.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].childNodes.length === 1 && spans[i].childNodes[0].nodeType === 3) {
        spans[i].textContent = text;
        return;
      }
    }
  }

  function syncNav(nav) {
    var links = nav.querySelectorAll('a');
    var contactContainer = null;
    var flexRow = null;

    for (var i = 0; i < links.length; i++) {
      var text = labelOf(links[i]);

      // Hydration can restore the original anchor hrefs; re-assert real routes.
      if (ROUTES[text] && links[i].getAttribute('href') !== ROUTES[text]) {
        links[i].setAttribute('href', ROUTES[text]);
        links[i].setAttribute('target', '_top');
      }

      if (RELABEL[text]) setLabel(links[i], RELABEL[text]);

      if (text === 'Contact') {
        var c = links[i].parentElement;
        if (c && c.className && String(c.className).indexOf('-container') !== -1) {
          var row = c.parentElement;
          if (row && row.textContent.indexOf('About') !== -1) {
            contactContainer = c;
            flexRow = row;
          }
        }
      }
    }

    if (!contactContainer || !flexRow) return;

    // Insert in reverse so the rendered order matches EXTRA.
    for (var j = EXTRA.length - 1; j >= 0; j--) {
      var spec = EXTRA[j];
      if (nav.querySelector('.' + spec.cls)) continue;

      var node = contactContainer.cloneNode(true);
      node.classList.add(spec.cls);

      var anchor = node.tagName === 'A' ? node : node.querySelector('a');
      if (anchor) {
        anchor.setAttribute('href', spec.href);
        anchor.setAttribute('target', '_top');
      }
      setLabel(node, spec.label);
      flexRow.insertBefore(node, contactContainer);
    }
  }

  function run() {
    var navs = document.querySelectorAll('nav');
    for (var i = 0; i < navs.length; i++) syncNav(navs[i]);
  }

  run();
  if (document.body) {
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      run();
      new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
    });
  }
})();
</script>
`;

// --- sitemap & robots --------------------------------------------------------

// Neither file existed before this (both returned 404), which meant nothing could
// be submitted to Search Console and crawlers had no index to work from.
// SITE is rewritten apex -> www on write, matching every canonical on the site.
function writeSitemap(entries) {
  const urls = entries
    .map(
      ({ loc, priority, lastmod }) =>
        `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod || new Date().toISOString().slice(0, 10)}</lastmod>\n    <priority>${priority}</priority>\n  </url>`,
    )
    .join('\n');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${urls}\n` +
    '</urlset>\n';
  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    xml.replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com'),
  );
  console.log(`  ✓ sitemap -> dist/sitemap.xml (${entries.length} URLs)`);
}

// IndexNow lets us notify Bing (and Yandex, Seznam, Naver) of new or changed URLs
// programmatically. Google does not participate, and its own Indexing API is
// restricted to JobPosting/BroadcastEvent — Google URLs still have to be submitted
// by hand in Search Console.
//
// The key is public by design: search engines verify ownership by fetching this
// file from the site root and checking it matches the key in the submission. It is
// not a secret and does not need protecting.
const INDEXNOW_KEY = '578535072428959e7ab91a2f84141b9b';

function writeIndexNowKey() {
  fs.writeFileSync(path.join(DIST, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
  console.log(`  ✓ indexnow key -> dist/${INDEXNOW_KEY}.txt`);
}

// llms.txt — a clean markdown summary of the site for LLM crawlers.
//
// This exists specifically to sidestep the homepage DOM problem: the Framer export
// renders each breakpoint variant into the same DOM and repeats the testimonial
// marquee, so a CSS-blind reader sees the homepage at ~2.7x its unique word count.
// This file gives those crawlers one unambiguous pass over the same facts.
//
// Generated from the content collections rather than hand-written, so it cannot
// drift out of date as pages are added or renamed.
function writeLlmsTxt({ services, cases, posts, pages }) {
  const line = (p, prefix = '') => {
    const desc = p.description ? ` — ${p.description.split('.')[0]}.` : '';
    return `- [${p.title}](${SITE}${prefix}/${p.slug})${desc}`;
  };
  const caseLine = (c) => {
    const desc = c.description ? ` — ${c.description.split('.')[0]}.` : '';
    return `- [${c.title}](${SITE}/${c.slug})${desc}`;
  };

  const body = [
    '# Vaeral',
    '',
    '> Online reputation management agency helping brands build and defend credibility',
    '> across Reddit, Quora, LinkedIn and AI search. Founded 2022, based in Guwahati,',
    '> India, working with clients globally.',
    '',
    '## What we do',
    '',
    'Vaeral is an ORM agency. We work on how a brand appears in community discussions,',
    'in Google search results, and in AI-generated answers from ChatGPT, Perplexity and',
    'Google AI Overviews. We work within platform rules: Reddit, Quora and Wikipedia all',
    'prohibit undisclosed coordinated promotion, and we do not place, buy or incentivise',
    'reviews.',
    '',
    "## What we don't do",
    '',
    '- We do not create fake accounts or astroturf discussions',
    '- We do not buy or place reviews on behalf of clients',
    '- We do not offer guaranteed removal of third-party content',
    '- We do not run campaigns that violate Reddit, Quora or Wikipedia platform rules',
    '- We do not work on black-hat SEO or link schemes',
    '',
    '## Services',
    '',
    ...services.map((s) => line(s, '/services')),
    '',
    '## Case studies',
    '',
    'Client work is described by sector rather than by name.',
    '',
    ...cases.map(caseLine),
    '',
    '## Frequently asked questions',
    '',
    '**What is online reputation management?**',
    'ORM is the practice of monitoring, influencing and improving how a brand appears in online conversations, search results and AI-generated answers. It includes community management, content strategy, review management and structured visibility work across platforms like Reddit, Quora and Google.',
    '',
    '**How long does reputation recovery take?**',
    'Most brands see measurable sentiment improvement within 60–90 days. Sustainable changes to Google search results typically take 3–6 months. AI answer citations follow once sufficient third-party corroboration exists, usually 4–8 months from campaign start.',
    '',
    '**Does Vaeral work within platform rules?**',
    'Yes. All community work is disclosed where required by platform policy. We do not place, buy or incentivise reviews, and we do not operate fake accounts.',
    '',
    '**What is Answer Engine Optimization (AEO)?**',
    'AEO is the practice of structuring content so that AI engines such as ChatGPT, Perplexity and Google AI Overviews extract and cite it in response to user questions. It involves structured data, direct-answer formatting, entity building and third-party corroboration.',
    '',
    '**Who does Vaeral work with?**',
    'Vaeral works with D2C brands, SaaS companies, fintech platforms, e-commerce businesses and individual founders. Most clients are Indian businesses, though we serve clients globally.',
    '',
    '## Company',
    '',
    '- Founded: 2022',
    '- Legal entity: House of Swing',
    '- Founder: Mayank Sureka',
    '- Location: Guwahati, Assam, India (serving clients globally)',
    '- Contact: contact@vaeral.com',
    '- LinkedIn: https://www.linkedin.com/company/vaeral/',
    '- Instagram: https://www.instagram.com/vaeral.media_',
    ...pages.map((p) => `- [${p.title}](${SITE}/${p.slug})`),
    '',
    '## Blog',
    '',
    `- [Full index](${SITE}/blog)`,
    ...posts.map((p) => `- [${p.title}](${SITE}/blog/${p.slug})`),
    '',
  ].join('\n');

  fs.writeFileSync(
    path.join(DIST, 'llms.txt'),
    body.replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com'),
  );
  console.log('  ✓ llms.txt -> dist/llms.txt');
}

// AI crawlers: ALLOWED, by owner decision 2026-07-27 (P6-T4).
//
// `User-agent: *` already permits these, so naming them changes nothing
// technically. They are listed explicitly so the permissiveness reads as a
// decision rather than an oversight — otherwise a future contributor has no way
// to tell, and "tighten robots.txt" is a common drive-by change.
//
// The rationale: Vaeral sells AI search visibility. Retrieval crawlers are the
// mechanism by which the site can be cited in AI answers at all, so blocking them
// would contradict the service. Training crawlers are allowed too, as the same
// decision.
//
// Note Google-Extended governs Gemini and AI Overviews grounding only — it has no
// effect on ordinary Google Search ranking, which is a common misreading.
const AI_CRAWLERS = [
  ['OAI-SearchBot', 'ChatGPT search — retrieval for live answers'],
  ['PerplexityBot', 'Perplexity — retrieval for live answers'],
  ['Google-Extended', 'Gemini / AI Overviews grounding (not Search ranking)'],
  ['GPTBot', 'OpenAI — training'],
  ['ClaudeBot', 'Anthropic — training'],
  ['CCBot', 'Common Crawl — feeds many downstream models'],
];

function writeRobots() {
  const aiSection = AI_CRAWLERS.flatMap(([agent, why]) => [
    `# ${why}`,
    `User-agent: ${agent}`,
    'Allow: /',
    '',
  ]);

  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    '# AI crawlers are explicitly allowed. Vaeral works on AI search visibility,',
    '# and these crawlers are what make citation in AI answers possible.',
    '',
    ...aiSection,
    `Sitemap: ${SITE}/sitemap.xml`,
    '',
  ].join('\n');
  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    body.replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com'),
  );
  console.log('  ✓ robots -> dist/robots.txt');
}

// --- homepage SEO -----------------------------------------------------------

// The homepage is a frozen Framer export, so its <head> can't be edited through the
// CMS the way template-driven pages can. Patch the SEO-relevant tags here at build
// time instead of hand-editing index.html, so a fresh Framer re-export doesn't
// silently revert them.
const HOME_TITLE = 'Reddit & Quora Marketing Agency | Brand Reputation | Vaeral';
// Kept under 155 chars so search engines don't truncate it mid-sentence.
const HOME_DESCRIPTION =
  'Vaeral rebuilds brand trust online through Reddit marketing, Quora marketing, AI search visibility and review management.';

// Homepage copy corrections, applied at build time for the same reason as the SEO
// head tags: index.html is a frozen Framer export, and patching here means a fresh
// re-export cannot silently reinstate the old wording.
//
// Two of these are compliance-driven rather than stylistic. "Proxy-backed clusters"
// and "we seed authentic reviews" describe practices that breach Reddit, Quora and
// Wikipedia policy and India's CCPA fake-review guidance (BIS IS 19000:2022) - and
// since the service pages shipped, they also directly contradict
// /services/review-management, which states Vaeral does not place or buy reviews.
// A site that contradicts itself gives answer engines conflicting evidence about
// the same entity.
//
// The statistics are replaced rather than deleted: each says the same thing in a
// form that does not depend on an unpublished number. Uncited precision is
// discounted by answer engines, and a 100%-success claim sat badly next to a
// service page saying nobody can guarantee a Wikipedia page.
const HOMEPAGE_COPY = [
  {
    what: 'proxy-backed clusters',
    count: 1,
    from: 'With proxy-backed clusters, original ideas, and tailored blueprints, we turn crises into non‑events stopping trouble before it starts.',
    to: 'With community strategy, original research and tailored response playbooks, we turn crises into non‑events — stopping trouble before it starts.',
  },
  {
    what: 'seeding reviews',
    count: 2,
    from: 'We seed authentic reviews and craft balanced, rapid-fire responses',
    to: 'We help you earn reviews from real customers and craft balanced, rapid-fire responses',
  },
  {
    what: 'Quora lifespan statistic',
    count: 3,
    from: 'Our Quora answers have Google ranking lifespan of 13 months. Most ads last 13 days.',
    to: 'A well-placed Quora answer keeps earning views years after it is written. A paid ad stops the day you stop paying.',
  },
  {
    what: 'Wikipedia success-rate statistic',
    count: 3,
    from: '100% of our Wikipedia pages have passed editorial review on the first attempt.',
    to: 'We assess notability before we write. If the independent coverage is not there yet, we say so — a declined draft costs months.',
  },
  {
    what: 'AI-answers statistic',
    count: 3,
    from: '95% of our clients appear in AI-generated answers on ChatGPT, Google AI Overview, and Perplexity within 60 days.',
    to: 'We track whether your brand appears in AI answers across ChatGPT, Google AI Overviews and Perplexity — measured on a fixed prompt set, re-run on a schedule, so you can see it change.',
  },
  {
    // Missing space, visible to every reader, repeated once per testimonial copy.
    what: 'teamgot typo',
    count: 8,
    from: 'Mayank &amp; teamgot it done',
    to: 'Mayank &amp; team got it done',
  },
];

function patchHomepageCopy(html) {
  for (const { what, from, to, count } of HOMEPAGE_COPY) {
    const found = html.split(from).length - 1;
    if (found !== count) {
      // Fail the build rather than ship half-corrected copy: a Framer re-export that
      // reworded one of these would otherwise reinstate it silently.
      throw new Error(`homepage copy patch "${what}": expected ${count} occurrence(s), found ${found}`);
    }
    html = html.split(from).join(to);
  }
  return html;
}

function patchHomepageSeo(html) {
  const before = html;

  html = html
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(HOME_TITLE)}</title>`)
    .replace(
      /(<meta property="og:title" content=")[^"]*(")/i,
      `$1${escapeHtml(HOME_TITLE)}$2`,
    )
    .replace(
      /(<meta name="twitter:title" content=")[^"]*(")/i,
      `$1${escapeHtml(HOME_TITLE)}$2`,
    )
    .replace(
      /(<meta name="description" content=")[^"]*(")/i,
      `$1${escapeHtml(HOME_DESCRIPTION)}$2`,
    )
    .replace(
      /(<meta property="og:description" content=")[^"]*(")/i,
      `$1${escapeHtml(HOME_DESCRIPTION)}$2`,
    )
    .replace(
      /(<meta name="twitter:description" content=")[^"]*(")/i,
      `$1${escapeHtml(HOME_DESCRIPTION)}$2`,
    );

  // Open Graph requires absolute URLs — a relative path renders a blank preview card
  // on LinkedIn/WhatsApp/Slack/X. (SITE is rewritten apex -> www on write.)
  html = html.replace(
    /(<meta (?:property|name)="(?:og|twitter):image" content=")(\/[^"]*)(")/gi,
    (_m, open, relPath, close) => open + SITE + relPath + close,
  );

  if (html === before) {
    throw new Error('homepage SEO patch matched nothing — index.html <head> layout changed');
  }

  // The organisation node is the anchor every other page's schema @id-references,
  // so it belongs on the homepage specifically.
  const ld = schema.renderJsonLd([
    schema.organization(SITE),
    schema.webSite(SITE),
    schema.speakablePage({ url: `${SITE}/` }),
  ]);
  if (!html.includes('</head>')) {
    throw new Error('homepage has no </head> — cannot attach structured data');
  }
  html = html.replace('</head>', `${ld}\n</head>`);

  return html;
}

// --- main ------------------------------------------------------------------

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  // Ship CMS-uploaded / localized images into the deploy root.
  copyDir(PUBLIC_ASSETS, DIST_ASSETS);

  // Ship the Decap CMS editor (index.html + config.yml) so /admin is served.
  copyDir(PUBLIC_ADMIN, DIST_ADMIN);

  const blog = readMarkdownDir(path.join(CONTENT, 'blog'));
  const cases = readMarkdownDir(path.join(CONTENT, 'case-studies'));

  const publishedPosts = [];
  for (const entry of blog) {
    if (entry.attributes.draft) {
      console.log(`  · skip (draft): blog/${entry.file}`);
      continue;
    }
    publishedPosts.push(buildBlogPost(entry, blog));
    console.log(`  ✓ blog/${entry.attributes.slug} -> dist/blog/${entry.attributes.slug}/index.html`);
  }

  const publishedCases = [];
  for (const entry of cases) {
    if (entry.attributes.draft) {
      console.log(`  · skip (draft): case-studies/${entry.file}`);
      continue;
    }
    publishedCases.push(buildCaseStudy(entry));
    console.log(`  ✓ case-study/${entry.attributes.slug} -> dist/${entry.attributes.slug}/index.html`);
  }

  const publishedServices = [];
  for (const entry of readMarkdownDir(path.join(CONTENT, 'services'))) {
    if (entry.attributes.draft) {
      console.log(`  · skip (draft): services/${entry.file}`);
      continue;
    }
    publishedServices.push(
      buildStandardPage(entry, {
        dir: 'services',
        breadcrumbParent: { name: 'Services', url: `${SITE}/services` },
        schemaType: 'Service',
      }),
    );
    console.log(`  ✓ service/${entry.attributes.slug} -> dist/services/${entry.attributes.slug}/index.html`);
  }

  const publishedPages = [];
  for (const entry of readMarkdownDir(path.join(CONTENT, 'pages'))) {
    if (entry.attributes.draft) {
      console.log(`  · skip (draft): pages/${entry.file}`);
      continue;
    }
    publishedPages.push(
      buildStandardPage(entry, {
        dir: '',
        breadcrumbParent: null,
        schemaType: entry.attributes.slug === 'about' ? 'AboutPage' : 'WebPage',
      }),
    );
    console.log(`  ✓ page/${entry.attributes.slug} -> dist/${entry.attributes.slug}/index.html`);
  }

  buildServiceIndex(publishedServices);
  console.log(`  ✓ services listing -> dist/services/index.html (${publishedServices.length} services)`);

  buildBlogIndex(publishedPosts);
  console.log(`  ✓ blog listing -> dist/blog/index.html (${publishedPosts.length} posts)`);

  buildCaseStudyIndex(publishedCases);
  console.log(`  ✓ case study listing -> dist/casestudies/index.html (${publishedCases.length} case studies)`);

  writeSitemap([
    { loc: `${SITE}/`, priority: '1.0', lastmod: today },
    ...publishedPages.map((p) => ({ loc: p.url, priority: '0.8', lastmod: p.date ? isoDate(p.date).slice(0, 10) : today })),
    { loc: `${SITE}/services`, priority: '0.9', lastmod: today },
    ...publishedServices.map((p) => ({ loc: p.url, priority: '0.9', lastmod: p.date ? isoDate(p.date).slice(0, 10) : today })),
    { loc: `${SITE}/casestudies`, priority: '0.7', lastmod: today },
    ...publishedCases.map((c) => ({ loc: `${SITE}/${c.slug}`, priority: '0.7', lastmod: c.date ? isoDate(c.date).slice(0, 10) : today })),
    { loc: `${SITE}/blog`, priority: '0.7', lastmod: today },
    ...publishedPosts.map((p) => ({ loc: `${SITE}/blog/${p.slug}`, priority: '0.6', lastmod: p.date ? isoDate(p.date).slice(0, 10) : today })),
  ]);
  writeLlmsTxt({
    services: publishedServices,
    cases: publishedCases,
    posts: publishedPosts,
    pages: publishedPages,
  });
  writeRobots();
  writeIndexNowKey();

  // Force hard navigation for all internal links on the homepage to bypass Framer SPA router
  // First, copy the source index.html into dist if it doesn't already exist
  const indexFile = path.join(DIST, 'index.html');
  const sourceIndex = path.join(path.dirname(DIST), 'index.html');
  if (fs.existsSync(sourceIndex)) {
    fs.copyFileSync(sourceIndex, indexFile);
  }
  if (fs.existsSync(indexFile)) {
    let indexHtml = fs.readFileSync(indexFile, 'utf8');

    // Static HTML changes to Framer components are reverted by React hydration, so
    // the nav is re-asserted at runtime by NAV_SCRIPT (defined above).
    const blogNavScript = NAV_SCRIPT;

    const styleFix = `
<style>
  html, body, div, h1, h2, h3, h4, h5, h6, p, span, a, section, article, img { -webkit-user-select: none !important; user-select: none !important; }
  input, textarea, [contenteditable] { -webkit-user-select: auto !important; user-select: auto !important; }
  [contenteditable]:not(input):not(textarea) { -webkit-user-modify: read-only !important; user-modify: read-only !important; caret-color: transparent !important; }
  
  /* Nav sizing. The previous version pinned these to 187.453px / 374.453px so a
     4th link could overflow a frozen box without re-running the flex maths. That
     hardcoding was the reason the nav couldn't take another link — Framer's own
     CSS is width:min-content / width:auto and sizes itself fine.
     Restoring that lets the row grow naturally for 5 links; the parent is
     space-between, so the logo stays put. overflow stays visible because the
     export sets overflow:hidden on the row, which would otherwise clip. */
  .framer-1tnpw2r { gap: 15px !important; overflow: visible !important; width: auto !important; }
  .framer-8gg6gi-container { overflow: visible !important; width: auto !important; }
  .framer-1y9d1w4 { overflow: visible !important; width: min-content !important; }
</style>
`;

    const contactFormScript = `
<script>
(function() {
  setInterval(function() {
    var nameField = document.querySelector('input[placeholder="Full name"]');
    if (!nameField) return;
    var form = nameField.closest('form');
    if (!form || form.dataset.vaeralInjected) return;
    
    form.dataset.vaeralInjected = "true";
    
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      
      var nameInput = form.querySelector('input[name="Name"]');
      var emailInput = form.querySelector('input[name="Email"]');
      var phoneInput = form.querySelector('input[name="Phone"]');
      var submitBtn = form.querySelector('button[type="submit"]');
      
      var name = nameInput ? nameInput.value.trim() : '';
      var email = emailInput ? emailInput.value.trim() : '';
      var phone = phoneInput ? phoneInput.value.trim() : '';
      
      if (!name || !email || !phone) {
        alert("Please fill in Name, Email, and Phone.");
        return;
      }
      
      var originalText = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.textContent = "Sending...";
        submitBtn.disabled = true;
        submitBtn.style.opacity = "0.7";
      }
      
      try {
        var res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, email: email, phone: phone })
        });
        
        if (res.ok) {
          if (submitBtn) {
            submitBtn.textContent = "Message Sent!";
            submitBtn.style.opacity = "1";
          }
          if(nameInput) nameInput.value = '';
          if(emailInput) emailInput.value = '';
          if(phoneInput) phoneInput.value = '';
          setTimeout(function() {
            if (submitBtn) {
              submitBtn.textContent = originalText;
              submitBtn.disabled = false;
            }
          }, 4000);
        } else {
          var data = await res.json().catch(function() { return {}; });
          alert("Error: " + (data.message || "Failed to send message."));
          if (submitBtn) {
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
            submitBtn.style.opacity = "1";
          }
        }
      } catch (err) {
        console.error(err);
        alert("Network error. Please try again.");
        if (submitBtn) {
          submitBtn.textContent = originalText;
          submitBtn.disabled = false;
          submitBtn.style.opacity = "1";
        }
      }
    });
  }, 1000);
})();
</script>
`;

    const newsletterFormScript = `
<script>
(function() {
  setInterval(function() {
    var forms = document.querySelectorAll('form.framer-w8wwxz');
    forms.forEach(function(form) {
      if (form.dataset.vaeralNewsletterInjected) return;
      form.dataset.vaeralNewsletterInjected = "true";

      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        e.stopImmediatePropagation();

        var emailInput = form.querySelector('input[type="email"]');
        var submitBtn = form.querySelector('button[type="submit"]');

        var email = emailInput ? emailInput.value.trim() : '';
        if (!email) {
          alert("Please enter your email address.");
          return;
        }

        var originalText = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) {
          submitBtn.textContent = "Subscribing...";
          submitBtn.disabled = true;
          submitBtn.style.opacity = "0.7";
        }

        try {
          var res = await fetch('/api/newsletter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
          });

          if (res.ok) {
            if (submitBtn) {
              submitBtn.textContent = "Subscribed ✓";
              submitBtn.style.opacity = "1";
            }
            if (emailInput) emailInput.value = '';
            setTimeout(function() {
              if (submitBtn) {
                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
              }
            }, 4000);
          } else {
            var data = await res.json().catch(function() { return {}; });
            alert("Error: " + (data.message || "Failed to subscribe."));
            if (submitBtn) {
              submitBtn.textContent = originalText;
              submitBtn.disabled = false;
              submitBtn.style.opacity = "1";
            }
          }
        } catch (err) {
          console.error(err);
          alert("Network error. Please try again.");
          if (submitBtn) {
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
            submitBtn.style.opacity = "1";
          }
        }
      });
    });
  }, 1000);
})();
</script>
`;

    if (indexHtml.includes('</body>')) {
      indexHtml = indexHtml.replace('</body>', styleFix + HOMEPAGE_FIX_STYLES + NAV_PREFERRED_SOURCE_STYLES + blogNavScript + CASE_STUDIES_CTA_SCRIPT + servicesSectionScript(publishedServices) + NAV_PREFERRED_SOURCE_SCRIPT + contactFormScript + newsletterFormScript + '</body>');
    }

    const preloads = `
<link rel="preload" as="image" href="https://framerusercontent.com/images/r0nnngidlqmFQKjVhqENbu42IA.png?width=1316&height=574">
<link rel="preload" as="image" href="https://framerusercontent.com/images/sNKeQAU4GFrqfgvCqAIvZCU1KRA.png?scale-down-to=1024&width=1161&height=1080">
<link rel="preload" as="image" href="https://framerusercontent.com/images/n2ZMsJIF5MgwK89prVzJKbCUcS0.jpg?scale-down-to=1024&width=6000&height=4000">
<link rel="preload" as="image" href="https://framerusercontent.com/images/ui8KS5G13xZLHx95GVXLocBVlU.png?width=527&height=895">
`;
    if (indexHtml.includes('</head>')) {
      indexHtml = indexHtml.replace('</head>', preloads + '</head>');
    }

    indexHtml = patchHomepageCopy(indexHtml);
    indexHtml = patchHomepageCaseStudiesCta(indexHtml);
    indexHtml = patchHomepageServices(indexHtml, publishedServices);
    indexHtml = patchHomepageSeo(indexHtml);
    indexHtml = patchNavHrefs(indexHtml, { isHomepage: true });
    indexHtml = disableSPARouting(indexHtml, true);
    fs.writeFileSync(indexFile, patchImages(indexHtml.replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com')));
    console.log(`  ✓ patched dist/index.html: SEO head tags, SPA routing, LCP preloads`);
  }

  console.log(`\nBuild complete: ${publishedPosts.length} posts, ${cases.filter((c) => !c.attributes.draft).length} case studies.`);
}

main();
