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
import { buildTeamWheelChunk, patchHomepageTeam } from './team-wheel.js';
import { buildFormChunks, applyFormChunkMap, assertNoFramerForms } from './framer-forms.js';

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

  /* --- Team block on phone -----------------------------------------------------------------
     The phone variant lays the team out as a card plus a wrapping row of chips, inside boxes the
     export sized for ten people: the chip container is a fixed 465px, its component root fills
     it at 100% and hides overflow, and the section is a fixed 893px. Sixteen chips wrap to four
     rows at 390px, so the last two rows were cut off at the card's edge — measured: rows end 95px
     below the container.

     Let the three boxes follow their content instead of a fixed count. The heights are the only
     things changed; padding, gap and every colour stay the export's. !important on the root
     because its height is set inline by the component. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-jl381u-container,
    .framer-ofgoy .framer-hceif5 {
      height: auto;
    }
    .framer-ofgoy .framer-jl381u-container [aria-label="Team carousel"] {
      height: auto !important;
    }
  }

  /* --- Team wheel on desktop ---------------------------------------------------------------
     The wheel sizes itself from its container (team-wheel.js), and the export leaves that
     container content-sized beside a 464px heading in a section padded 150/220, so the wider the
     screen the more empty room sat between the two. Let the wheel take that room, less 15% (the
     full fill read too big): 110px off the right edge, never over 714px and never under 570px.
     The floor exists because the card cannot shrink with the wheel — its text has a minimum
     size — so below it the card starts crowding the avatars on the diagonals.
     The section follows the wheel's height instead of holding the
     export's fixed 789px. Its 20/120 vertical padding was breathing room around a 520px wheel;
     at these sizes it just left the group sitting 50px above the section's middle, crowding the
     divider above and stranding a band of empty space below, so the padding is evened out to
     70/70 — which lands on the same section height at every width. Past 1604px the spare room
     splits evenly around the wheel rather
     than piling up on its left. The wheel's flex item is the min-content wrapper around the
     container (it also carries the export's 30px bottom padding), so the margins go on that. */
  @media (min-width: 1280px) {
    .framer-ofgoy .framer-hceif5 {
      height: auto;
      min-height: 789px;
      padding-top: 70px;
      padding-bottom: 70px;
      padding-right: 110px;
    }
    .framer-ofgoy .framer-353soo {
      margin-left: auto;
      margin-right: auto;
    }
    .framer-ofgoy .framer-un4g3d-container {
      --wheel: clamp(570px, 85vw - 650px, 714px);
      width: var(--wheel);
      height: var(--wheel);
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
     Split layout: the heading block sits left with a lede and a link to the hub, the ten
     services sit right as cards. The asymmetry is deliberate — it is the team section's
     arrangement ("The People Who Make it Happen" left, wheel right), so the page already
     reads this shape once and the services section rhymes with it instead of adding a third
     centred grid between the two.

     Section rhythm is still measured off the #casestudies chain so it shares the page's
     spacing exactly: wrapper max-width 1440px with padding 100px 0 0, content 1000px.
     Type and colour are set here rather than borrowed from a preset for the same reason the
     preferred-source card sets its own: 18px card titles and 14px body are a card-scale step
     below the smallest heading preset (24px), so there is no preset to borrow. The fills are
     the preferred-source card's (rgba(119,117,153,0.08) on a 0.28 border), which is this
     page's quiet card; the lavender hover border and the CTA are the export's own tokens. */
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
  .vaeral-services-inner {
    display: flex;
    flex-direction: column;
    /* The gap to the grid is deliberately larger than the grid's own 44px row gap, so the
       heading and button read as a header rather than as the first row of the list. */
    gap: 76px;
    width: 100%;
    max-width: 1000px;
    padding: 0 24px;
    box-sizing: border-box;
  }
  .vaeral-services-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 40px;
  }
  .vaeral-services-headtext { max-width: 34em; }
  /* position:relative so a Framer ::after cannot inset itself to the section instead. */
  .vaeral-services-h2 { position: relative; }
  .vaeral-services-lede {
    margin: 14px 0 0;
    font-family: Inter, "Inter Placeholder", sans-serif;
    font-size: 16px;
    line-height: 1.6;
    color: var(--token-f052e3c8-7cc9-4128-86fe-7a957812355f, #9b9bbd);
  }
  /* Matched to the nav's Get Started button, measured: the accent token, radius 12px,
     padding 12px 24px, label Inter 16px/1.3 in the #deddff token. */
  /* The button carries the same bloom as the rings, shaped to its own rectangle instead of a
     circle: a box-shadow glow rather than a radial gradient, which is the treatment the export
     already uses for its own lit controls. Resting strength is lower than the hover so there is
     somewhere to travel to. */
  .vaeral-services-cta {
    position: relative;
    flex: none;
    display: inline-block;
    background: var(--token-f951c3a8-aa43-4825-aa75-915aa92c20d1, #5036f9);
    border-radius: 12px;
    padding: 12px 24px;
    text-decoration: none;
    white-space: nowrap;
    box-shadow: 0 0 20px 0 rgba(80, 54, 249, 0.4);
    transition: box-shadow 0.22s ease, transform 0.2s cubic-bezier(0.44, 0, 0.56, 1);
  }
  /* The ring that travels outward once per pointer entry. It inherits the button's radius so it
     leaves as a rounded rectangle, not a circle. */
  .vaeral-services-cta::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    border: 1px solid rgba(197, 184, 255, 0.55);
    opacity: 0;
    transform: scale(0.94);
  }
  @keyframes vaeral-services-cta-ripple {
    from { transform: scale(0.94); opacity: 0.8; }
    to { transform: scale(1.2); opacity: 0; }
  }
  .vaeral-services-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 56px;
    row-gap: 44px;
    align-content: start;
  }
  .vaeral-services-item {
    display: flex;
    gap: 22px;
    align-items: flex-start;
    text-decoration: none;
    transition: transform 0.2s cubic-bezier(0.44, 0, 0.56, 1);
  }
  .vaeral-services-halo {
    position: relative;
    display: block;
    flex: none;
  }
  /* The resting bloom. Both stops are the page's own tokens read as rgb: #c5b8ff is
     rgb(197,184,255) and the accent #5036f9 is rgb(80,54,249) — a gradient cannot take a
     token through rgba(), so the components are written out rather than approximated. */
  .vaeral-services-halo::before {
    content: "";
    position: absolute;
    inset: -20px;
    border-radius: 50%;
    pointer-events: none;
    background: radial-gradient(50% 50%, rgba(197, 184, 255, 0.42) 0%, rgba(80, 54, 249, 0.26) 46%, rgba(80, 54, 249, 0) 74%);
    opacity: 0.72;
    transform: scale(0.92);
    transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.44, 0, 0.56, 1);
  }
  /* One ring travels outward each time a pointer arrives. Nothing loops on its own. */
  .vaeral-services-halo::after {
    content: "";
    position: absolute;
    inset: -20px;
    border-radius: 50%;
    pointer-events: none;
    border: 1px solid rgba(197, 184, 255, 0.55);
    opacity: 0;
    transform: scale(0.62);
  }
  @keyframes vaeral-services-ripple {
    from { transform: scale(0.62); opacity: 0.85; }
    to { transform: scale(1.5); opacity: 0; }
  }
  .vaeral-services-ring {
    position: relative;
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid rgba(80, 54, 249, 0.55);
    background: #02010a;
    color: var(--token-05f7c79d-9f6d-455d-9542-2f5b1e17e42e, #deddff);
    transition: border-color 0.2s ease, color 0.2s ease;
  }
  .vaeral-services-name {
    display: block;
    font-family: "Plus Jakarta Sans", "Plus Jakarta Sans Placeholder", sans-serif;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.02em;
    color: var(--token-55fce8bf-ab86-42dc-8b77-6335cf9cf588, #fff);
    transition: color 0.2s ease;
  }
  .vaeral-services-hook {
    display: block;
    margin: 6px 0 0;
    font-family: Inter, "Inter Placeholder", sans-serif;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--token-f052e3c8-7cc9-4128-86fe-7a957812355f, #9b9bbd);
  }
  @media (hover: hover) {
    .vaeral-services-item:hover { transform: translateX(6px); }
    .vaeral-services-item:hover .vaeral-services-halo::before { opacity: 1; transform: scale(1.18); }
    .vaeral-services-item:hover .vaeral-services-halo::after { animation: vaeral-services-ripple 0.95s cubic-bezier(0.22, 0.7, 0.3, 1); }
    .vaeral-services-item:hover .vaeral-services-ring {
      border-color: rgba(197, 184, 255, 0.9);
      color: var(--token-55fce8bf-ab86-42dc-8b77-6335cf9cf588, #fff);
    }
    .vaeral-services-item:hover .vaeral-services-name {
      color: var(--token-4c441323-6a04-4cdd-b867-6bcb5399d3b3, #c5b8ff);
    }
    .vaeral-services-cta:hover {
      box-shadow: 0 0 34px 2px rgba(80, 54, 249, 0.62);
      transform: translateY(-1px);
    }
    .vaeral-services-cta:hover::after {
      animation: vaeral-services-cta-ripple 0.95s cubic-bezier(0.22, 0.7, 0.3, 1);
    }
  }
  /* Keyboard gets the same bloom, so the feedback is not pointer-only. */
  .vaeral-services-item:focus-visible .vaeral-services-halo::before { opacity: 1; transform: scale(1.18); }
  .vaeral-services-cta:focus-visible { box-shadow: 0 0 34px 2px rgba(80, 54, 249, 0.62); }
  .vaeral-services-item:focus-visible,
  .vaeral-services-cta:focus-visible {
    outline: 2px solid rgba(197, 185, 246, 0.9);
    outline-offset: 6px;
    border-radius: 14px;
  }
  @media (prefers-reduced-motion: reduce) {
    .vaeral-services-item,
    .vaeral-services-halo::before { transition: none; }
    .vaeral-services-item:hover { transform: none; }
    .vaeral-services-item:hover .vaeral-services-halo::before { transform: scale(1); }
    .vaeral-services-item:hover .vaeral-services-halo::after { animation: none; }
    .vaeral-services-cta { transition: box-shadow 0.22s ease; }
    .vaeral-services-cta:hover { transform: none; }
    .vaeral-services-cta:hover::after { animation: none; }
  }
  @media (max-width: 1099.98px) {
    .vaeral-services-grid { column-gap: 36px; }
  }
  /* Phone: one column, and the head stacks so the button is not squeezed beside the lede.
     There is no hover on touch, so the bloom rests at full strength — the dimmed resting
     state only makes sense where a pointer can lift it. */
  @media (max-width: 809.98px) {
    .vaeral-services { padding-top: 60px; }
    .vaeral-services-inner { padding: 0 20px; gap: 48px; }
    .vaeral-services-head { flex-direction: column; align-items: flex-start; gap: 22px; }
    .vaeral-services-headtext { max-width: none; }
    .vaeral-services-grid { grid-template-columns: 1fr; row-gap: 26px; }
    .vaeral-services-item { gap: 16px; }
    .vaeral-services-halo::before { opacity: 1; transform: scale(1); }
    .vaeral-services-ring { width: 44px; height: 44px; }
    .vaeral-services-cta { box-shadow: 0 0 26px 1px rgba(80, 54, 249, 0.52); }
  }
  /* --- Hero graphic on phone ---------------------------------------------------------------
     Two faults at 390px, one cause each. Both measured, neither guessed.

     1. The glowing "#V" plate was sliced off down its right edge. The export's own phone rule
        (left:unset; right:-2px; width:239px) does apply — used left is 153px, so the BOX is
        153..392, the 2px bleed Framer intended. What overflows is the inline transform:
        rotate(13deg) baked onto the element. A 239x405.891 box turned 13deg has an axis-aligned
        box of 239*cos13 + 405.891*sin13 = 324.18 wide, so (324.18-239)/2 = 42.59px of slack
        appears on each side and the rotated right edge landed at 434.6 — 44.6px past the
        viewport. right:43px is that slack rounded up: the box moves in by exactly what the
        rotation adds, and the rotated edge lands at 389.6. The art, its size and its tilt are
        untouched; only the offset that never accounted for the tilt changes.

     2. The grey sub-headline sat inside the bloom. The hero column is a fixed 650px with
        justify-content:flex-end, so the copy is pinned to its bottom (grey line y 361.8..457)
        while the graphic hangs from top:-59px and ends at y 516.6 — the line lay entirely over
        the brightest part. The line is white at 0.66 alpha so it composites over whatever is
        behind it: 2.52% of its area measured below 4.5:1, worst 2.24:1. top:-132px is the value
        the export already uses for this same element at the tablet breakpoint, not a new number,
        and it drops that to 0.01% of area, worst 2.62:1, by lifting the bloom clear of the text.
        The plate's top corner ends at y -5.7, behind the opaque nav band (0..80) where it
        already was at top:-59, so nothing visible is lost.

     Full separation is not reachable here: it needs a 155px lift, which would put half the #V
     behind the nav. This is the limit without moving the copy, which would be a redesign.

     Selector carries .framer-ofgoy because the export's own rule does (0,2,0) — a bare
     .framer-byxt38 loses the cascade and is silently ignored. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-byxt38 {
      right: 43px;
      top: -132px;
    }
  }

  /* --- Contact fields on phone -------------------------------------------------------------
     The three contact inputs render at 14px. Mobile Safari zooms the whole page in whenever the
     field being focused is under 16px, and it does not zoom back out again, so tapping "Full
     name" left the page enlarged and side-scrolling — on the one form that converts.

     16px is the export's own value for a form field on this page, not an invented one: the
     footer's newsletter input is already 16px and does not trigger the zoom. The export simply
     contradicts itself between its two forms.

     Text-only change, verified to move nothing: field wrapper stays 277x40, the form 317px,
     #contact 665px and the document 17633px, before and after. */
  @media (max-width: 809.98px) {
    #contact .framer-form-text-input input { font-size: 16px; }
  }

  /* --- Case-studies CTA heading on phone ---------------------------------------------------
     "Next could be your case study." is the one heading on this page that never got a phone
     step. Its size is an inline --framer-font-size: 60px on the h2 itself, so it renders at
     60px/66px at every width; at 390 the card's column is 320px and the line wraps to FOUR
     lines, 264px tall inside a 417px card — the heading is most of the card and the "Write to
     us today" button gets pushed onto its bottom edge.

     Every other h2 on the phone drops to 36px/43.2px — measured on the preset that renders
     "Still Stuck in The Performance Marketing Trap?", which sits one section below this one and
     does exactly that. So 36px/43.2px is this page's own phone h2 size, not a new number.
     Measured result: 4 lines -> 3, box 264px -> 130px, document 17633 -> 17498.

     font-size and line-height are set directly rather than through --framer-font-size /
     --framer-line-height, because those two are inline on the element and a stylesheet cannot
     outrank an inline custom property without !important. .framer-ofgoy is on the selector for
     the usual reason: the export's own rules are (0,2,0) and a bare class is ignored. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-v3uq8l h2.framer-text {
      font-size: 36px;
      line-height: 43.2px;
    }
  }

  /* --- Four spacing values the export never stepped down for phone -------------------------
     Measured, not guessed. The phone page is 17633px against desktop's 12033, but that +5600 is
     almost entirely content reflow, which is correct: #features' card stack is 3388px at 390
     against 1835 at 1280 while the section's own padding already halves 160->80, and #contact
     and #testimonials are actually SHORTER on phone than on desktop. Empty vertical bands total
     2832px, i.e. ordinary section separation, not waste.

     Only four containers carry a value identical to their 1280px one AND cost real height. The
     twelve testimonial cards match too but are a marquee — all twelve share top 14362, so their
     padding stacks nothing.

     Every replacement is that value halved, which is the export's own phone idiom (#features
     160->80, #contact 120->60 at this same breakpoint), and every result is a number the export
     already uses on phone: 50 is .framer-fbd1z7's row-gap and #testimonials' padding-top, 30 is
     #contact's row-gap. #testimonials is the clearest oversight of the four — the export halved
     its top 80->50 and left its bottom at the desktop 120.

     Deliberately NOT touched: .framer-fbd1z7's 50px between case-study cards, and the 40px gaps
     in the footer and #features. Those are already the right rhythm and halving them reads
     cramped. This is worth 190px of 17633 (1.1%) — it corrects leakage on principle, it is not
     what makes the page long.

     Verified: phone 17633 -> 17443, desktop 12033 -> 12033 with every computed value unchanged,
     and no collision or lost separation at any of the three checked offsets. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-1a0ymfr { row-gap: 50px; }
    .framer-ofgoy #casestudies { row-gap: 30px; }
    .framer-ofgoy #testimonials { padding-bottom: 60px; }
    .framer-ofgoy .framer-1j25bf1.framer-v-1a63o24 { padding-top: 50px; }
  }

  /* --- One content rail on phone ------------------------------------------------------------
     The page had no single left edge. Measured at 390px, the content started at five different
     insets going down: hero 30, #about 25, #features and #blog and the narrative band 20,
     #casestudies and #testimonials 10, #contact 30. The visible card edge wandered the same way
     — service cards sat at 20 and were 350 wide, case-study and testimonial cards at 10 and 370,
     the contact card at 37 and 317. Nothing lined up with anything above or below it, which is
     what makes a phone page feel like a shrunken desktop rather than something built for the
     device.

     20px is not a new number: it is the inset the export itself already gives #features, #blog
     and the narrative band on phone, and it is where the service cards already sit. Putting the
     five odd sections on it makes every card on the page 350px at x=20 and gives the eye one
     rail to follow.

     The contact form needed two extra rules because it was pinned, not padded. Its wrapper
     .framer-ntvl0g carries a hard width:367px which broke it out of #contact's own padding, and
     the card .framer-d4nayf a hard width:317px inside that. width:100% is .framer-d4nayf's OWN
     base rule — the phone breakpoint overrides it to 317px — so restoring it is giving the card
     back its declared behaviour. The form goes 317 -> 350 wide, and its fields and the Submit
     button span the card instead of sitting in a narrow inset column.

     Verified at 390: hero copy, contact form, case-study card and testimonial card all report
     left 20 / width 350; document 17308 -> 17291; scrollWidth stays 390, so nothing gained a
     horizontal scroll. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-kvgeaa,
    .framer-ofgoy #about,
    .framer-ofgoy #casestudies,
    .framer-ofgoy #testimonials,
    .framer-ofgoy #contact {
      padding-left: 20px;
      padding-right: 20px;
    }
    .framer-ofgoy .framer-ntvl0g,
    .framer-ofgoy .framer-d4nayf { width: 100%; }
  }

  /* --- Service-card illustrations on phone -------------------------------------------------
     Five of the six illustrations in .framer-rqrgvh are position:absolute decoration inside a
     card with a fixed height and overflow:hidden, so capping an illustration saves nothing on
     its own — the card height is the lever and the art has to be re-fitted to match. Only
     .framer-16y7axw is in flow.

     214px is the cap, and it is the export's own number: .framer-1l25iqe already renders at 214
     on phone and .framer-5m52d at 213. Those two cards land on a 41% illustration-to-card ratio
     and .framer-5rq8mg independently matches it at 40%, so three of the six already agree. The
     outliers are .framer-1xupf9p at 63%, .framer-n27ev7 at 65% and .framer-16y7axw at 52%.

     Only width is set. Every one of these carries the export's aspect-ratio with
     height: var(--framer-aspect-ratio-supported, Npx), i.e. height is already auto and derived
     from width — so a width change cannot squash, it scales. Measured heights land at 213.9,
     214.0 and 214.5.

     Capping made two of them MORE legible, not less. .framer-1xupf9p was 637px wide inside a
     336px card, cutting 150px of circuit board off each side; at 374 that drops to 19px and the
     phone mockup's frame fits. .framer-n27ev7 was cropped 44px off its top; now 1.4px. Its
     left:50% is the export's own desktop value for this element — the phone override's left:-1%
     anchored the art near the card's left edge, and once scaled that left a 146px dead band.

     .framer-jcbzwd is 470, not the 426 a flat delta would give: at 426 the heading cut straight
     through the artwork. 470 scales the export's own image/text overlap by the same factor
     (257.7/364.3 x 214 = 151.4, + 278.3 text + 40 padding). .framer-q2w3s5 is 440 because it
     reproduces the ~2px gap the export leaves between that art's bottom and its heading.
     .framer-1ej1of4 needs no rule — it is min-content and follows its in-flow image down.

     Deliberately NOT touched: .framer-19xyygn, .framer-1lsar27 and .framer-1txirs4. Two of them
     define the cap and the third already sits on the ratio. These diagrams are the section's
     visual interest and a page of text blocks is worse than a slightly long page.

     Verified at 390: 17291 -> 17035, stack 3388 -> 3132, scrollWidth stays 390, no illustration
     reaches its card's bottom edge, and at 1280 all six card and illustration rects are
     identical with and without these rules. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-jcbzwd { height: 470px; }
    .framer-ofgoy .framer-1xupf9p { left: -19px; right: -19px; }
    .framer-ofgoy .framer-q2w3s5 { height: 440px; }
    .framer-ofgoy .framer-n27ev7 { width: 414px; left: 50%; }
    .framer-ofgoy .framer-16y7axw { width: 207px; }
  }

  /* --- Case studies as a swipe deck on phone -----------------------------------------------
     .framer-fbd1z7 is a 350px-wide column of five 494px cards: 2671px tall at 390, and five
     identical scroll-throughs of the same card shape. The page already owns the fix —
     #testimonials is a horizontal drag track at this same breakpoint — so the case studies
     become the same gesture rather than a new idiom.

     Row plus native scroll-snap on the real cards. Two things had to be found first, and both
     would have read as "snap is broken":

     1. The export's container is justify-content:center. Centred content in an overflowing flex
        box puts the first items at NEGATIVE offsets that scrollLeft cannot reach — measured, at
        scrollLeft 0 the THIRD card was on screen and cards 1-2 were unreachable at any scroll
        position. flex-start is the whole cure.
     2. The service-checklist panel's wrapper is a hard 350px — exactly the phone card width,
        i.e. it is drawn to bleed past the card's own 20px inner padding and sit flush with its
        border. At a narrower card it overflowed instead: labels lost their left edge and the
        tick boxes were cut. calc(100% + 40px) restates that same relationship against whatever
        the card now is, so the panel still lands on the card's edges. :has() picks the wrapper
        because its class differs per card while the component root .framer-E2mUP is shared.

     Card width is calc(100% - 40px), and 100% resolves against the container's content box, so
     the next card peeks by exactly 44px at any phone width: 310px cards at 390, 280px at 360,
     14-16% either way. That peek IS the affordance. The scrollbar is hidden because a snapping
     deck with a visible bar reads as a broken layout on iOS.

     height:auto is required before align-items:stretch will equalise the cards — narrower cards
     wrap their titles differently and came out 537-591px. order:0 overrides the export's own
     order:4/5 on the last two cards, which ran tab order backwards against visual order;
     harmless in a column, wrong in a row where focus drives the scroll.

     Measured at 390: container 2671 -> 537px, page 17035 -> 14901, and document scrollWidth
     stays 390 — the deck scrolls internally. Snap targets land exactly on 0/326/652/978/1264
     and all five cards reach full width. Tab walks all five links and exits, no trap. Desktop
     1280 and tablet 810 are byte-identical with and without this block, every card rect
     included. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-fbd1z7 {
      flex-direction: row;
      justify-content: flex-start;
      align-items: stretch;
      width: calc(100% + 40px);
      margin-left: -20px;
      margin-right: -20px;
      padding-left: 20px;
      padding-right: 20px;
      box-sizing: border-box;
      column-gap: 16px;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      scroll-snap-type: x mandatory;
      scroll-padding-left: 20px;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .framer-ofgoy .framer-fbd1z7::-webkit-scrollbar { display: none; }
    .framer-ofgoy .framer-fbd1z7 > .framer-lux5qc {
      flex: 0 0 calc(100% - 40px);
      width: calc(100% - 40px);
      height: auto;
      scroll-snap-align: start;
      order: 0;
    }
    .framer-ofgoy .framer-fbd1z7 div:has(> .framer-E2mUP) {
      width: calc(100% + 40px);
    }
    /* Mandatory snap takes the scroll away from the finger; proximity still parks the cards but
       never overrides a deliberate stop. All five stay reachable — verified. */
    @media (prefers-reduced-motion: reduce) {
      .framer-ofgoy .framer-fbd1z7 { scroll-snap-type: x proximity; }
    }
  }

  /* --- Services as a swipe deck on phone ---------------------------------------------------
     .framer-rqrgvh was 350x3132 at 390px — the largest block on the page and six full-height
     cards the reader scrolls past one at a time. It is a horizontal scroll-snap deck now, the
     same gesture #testimonials and the case studies already use. Nothing is redrawn and no copy,
     colour or type changes: the same six cards, laid along x instead of y.

     Structure first, because the stack does not hold six cards. It holds three Row wrappers
     (18s4q43, bz7ss3, wybi0i) plus ONE card sitting directly on it — .framer-1txirs4 is the
     LinkedIn card itself (data-framer-name="Card", the same rgba(255,255,255,.01) fill, 18px
     radius and 24/20/30 padding as its five siblings), not a fourth wrapper. So only three
     elements get display:contents.

     display:contents drops a wrapper's box, so it is only safe if that box carries nothing.
     Checked rather than assumed: all three Rows are background rgba(255,255,255,0), border 0,
     padding 0, overflow visible, no transform, no filter. Then every absolutely-positioned
     descendant was walked and its real containing block resolved — every one lands on its own
     card, which is position:relative, and NONE resolves to a Row. Dissolving them reparents no
     artwork. The LinkedIn card is the one element whose glow and image do use it as their
     containing block, and it keeps its box.

     Two traps, both of which break the deck silently, both measured:

     1. The export sets its own order values. wybi0i is order:3 and .framer-1txirs4 is order:2,
        LinkedIn renders FOURTH while sitting last in the DOM. Once the Rows dissolve, the cards'
        own orders apply directly against the deck and LinkedIn slides to position six — the
        service order would change without anyone asking. order:3/4 on the wybi0i pair restores
        the export's own sequence, reusing its own numbering.
     2. .framer-rqrgvh is justify-content:center. In an overflowing row scroller that centres the
        line and puts the first three cards at NEGATIVE offsets where scrolling cannot reach them
        — measured as scrollWidth 1870 collapsing to 1110, i.e. Reddit, Quora and Wikipedia
        permanently unreachable. flex-start is load-bearing, not tidying.

     Sizing: the deck sits inside the page's 20px rail, so its box is 350 wide. 300px cards on a
     14px gap leave 36px of the next card showing — 12% of a card, enough that the edge reads as
     swipeable rather than as a cropped layout.

     Height 551 on all six rather than ragged tops, and it is free here: every card is
     justify-content:flex-end, so extra height lands ABOVE the artwork as breathing room, not as
     dead space under the stat strip. Measured — Review Seeding's art moves 25.2px further down,
     LinkedIn's 17.3->25.8, Response Management's 24->45.1, and no card gains a gap at its bottom.
     551 is not a new number: it is Quora's own height, already the tallest of the six.

     At 300px the two left/right-anchored illustrations rescale with the card (1xupf9p 374->338,
     5rq8mg 388->338) and keep aspect ratio via the export's own --framer-aspect-ratio-supported
     height, so neither squashes; the four fixed-width ones crop ~27px more per side, which is
     diagram margin — the Wikipedia W-node, the LinkedIn profile mock and the Response Management
     hub all still sit inside. .framer-jcbzwd's 32px of clipped content is pre-existing.

     THIS BLOCK MUST STAY AFTER the illustration-fit rules above: the card height rules there are
     the same specificity (0,2,0), so source order is what makes 551 win over 470/440.

     Verified at 390: container 3132 -> 551, page 14901 -> 12320, documentElement.scrollWidth
     stays 390 — the deck scrolls internally, its own scrollWidth is 1870 — and the same holds at
     360/430/600/768/809. All six snap positions reachable in the export's order: Reddit 0, Quora
     314, Wikipedia 628, LinkedIn 942, Review Seeding 1256, Response Management 1520. One Tab
     reaches the deck and ArrowRight advances exactly one card; nothing inside is focusable so it
     cannot trap focus. At 1280 the stack is still column 1220x1835 with all six card rects
     identical. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-18s4q43,
    .framer-ofgoy .framer-bz7ss3,
    .framer-ofgoy .framer-wybi0i { display: contents; }

    .framer-ofgoy .framer-rqrgvh {
      flex-direction: row;
      flex-wrap: nowrap;
      justify-content: flex-start;
      align-items: flex-start;
      column-gap: 14px;
      row-gap: 0;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x mandatory;
      scroll-padding-left: 0;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }
    .framer-ofgoy .framer-rqrgvh::-webkit-scrollbar { display: none; }

    .framer-ofgoy .framer-jcbzwd,
    .framer-ofgoy .framer-19xyygn,
    .framer-ofgoy .framer-1lsar27,
    .framer-ofgoy .framer-1txirs4,
    .framer-ofgoy .framer-q2w3s5,
    .framer-ofgoy .framer-1ej1of4 {
      flex: 0 0 300px;
      width: 300px;
      height: 551px;
      scroll-snap-align: start;
    }
    .framer-ofgoy .framer-q2w3s5 { order: 3; }
    .framer-ofgoy .framer-1ej1of4 { order: 4; }
  }
  @media (max-width: 809.98px) and (prefers-reduced-motion: reduce) {
    .framer-ofgoy .framer-rqrgvh { scroll-snap-type: x proximity; }
  }

  /* --- Display type weight on phone ---------------------------------------------------------
     Light text on a near-black background optically gains weight — the glyphs bloom against the
     dark, so a given weight reads heavier than the same weight on white. The export never
     accounts for that: it ships the SAME weights at phone sizes that it uses at desktop sizes,
     where they are two-thirds larger and carry them comfortably.

     Measured at 390 vs 1280, the display text was identical in weight and roughly half the size:
       hero punchline   700 @36px on phone   vs   700 @68px on desktop
       "We show up"     700 @36px            vs   500 @52px
       emphasis inside  900 @36px            vs   700 @52px
       sub-heads        600 @18px            vs   600 @18px
     A weight that is right at 68px is chunky at 36px. The typographic rule is the ordinary one:
     as the size comes down, the weight should come down with it.

     So on phone only, display type steps down one notch to 600 and the 18px sub-heads to 500.
     Neither is a new number — 600 and 500 are both already in use on this page at this
     breakpoint. The 900 came from a <strong> nested inside an already-bold span, which is the
     browser compounding two bolds rather than a deliberate choice; 600 brings the whole heading
     onto one weight.

     Deliberately untouched: everything already at 500 or below. "Our Services" and the card
     titles like "Reddit Marketing" are 500 and stay there — an early attempt caught them in the
     same rule and made them HEAVIER, the opposite of the point.

     !important is needed twice over: the hero h1 carries its weight as an inline style, and the
     rest resolve through Framer's own --framer-font-weight custom property, so both the property
     and the longhand are set. Verified at 1280 that every one of these is unchanged: punchline
     still 700@68, "We show up" 500@52, sub-heads 600@18. */
  @media (max-width: 809.98px) {
    .framer-ofgoy h1.framer-text,
    .framer-ofgoy h1 span.framer-text,
    .framer-ofgoy h2 span.framer-text,
    .framer-ofgoy h3 span.framer-text,
    .framer-ofgoy h1 strong,
    .framer-ofgoy h2 strong,
    .framer-ofgoy h3 strong {
      --framer-font-weight: 600 !important;
      font-weight: 600 !important;
    }
    .framer-ofgoy .framer-styles-preset-g7i2u9,
    .framer-ofgoy .framer-styles-preset-171nmew,
    .framer-ofgoy .vaeral-services-name {
      --framer-font-weight: 500 !important;
      font-weight: 500 !important;
    }
  }

  /* --- "One post. One thread." animation cards, 10% smaller on phone -----------------------
     The three animated cards under that heading — the Reddit alert, the Quora "new mention" and
     the Play Store ratings mock — are the biggest objects in the narrative band: 335x411,
     350x415 and 335x434 at 390px, 1300px of card inside a 1922px section.

     Scaled to 90% via zoom on their shared wrapper rather than on each card. One rule instead of
     three, and it is the only primitive that shrinks the LAYOUT box as well as the painting —
     transform:scale would shrink the art but leave the original height reserved, so the section
     would keep its dead space.

     width:350px on the wrapper is its own current width restated inside the zoomed coordinate
     space. Without it the middle card, which is width:100%, resolves against a container that
     zoom has made 389 wide and stays 350 on screen while its two fixed-width siblings shrink —
     the cards would end up 302 / 350 / 302 and the middle one would look oddly wide. With it all
     three come down by exactly 10% on both axes and keep the export's own width relationship
     (the middle card stays the wider one, by the same 15px it always was). margin-inline:auto
     keeps the narrower group centred in the 20px rail.

     Measured at 390: cards 335x411 -> 302x370, 350x415 -> 315x374, 335x434 -> 302x391; wrapper
     350x1300 -> 315x1170; section 1922 -> 1792; page 12320 -> 12190. scrollWidth stays 390. At
     1280 the three cards are still 387x540 side by side and the page is still 12033 — zoom is
     inside the phone query, so desktop never sees it. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-1ydpcp4 {
      zoom: 0.9;
      width: 350px;
      margin-inline: auto;
    }
  }

  /* --- Two things sitting off-centre on phone ----------------------------------------------
     1. The hero's "Take Control of Your Brand Reputation" button. Its wrapper fills the 20px
        rail (20..370) but the button is 303.7 wide and flex-start inside it, so it sat at
        gapL 0 / gapR 46.3. Everything else in the hero is symmetric — the lead-in and the
        punchline span the rail 20/20, and the stat-chip row is centred 37.5/37.5 — which makes
        the button the only asymmetric thing there. At 303.7 of 350 it is too close to full
        width to read as deliberately left-aligned; it reads as off-centre, which is exactly
        how it was reported. auto margins centre it at 23.2/23.2 without changing its size.

        Left alone deliberately: on desktop the same button is flush left at gapL 0, and that IS
        correct there — the desktop hero is the asymmetric split, text column left against the
        glyph right. Only the phone layout is symmetric, so only the phone needs this.

     2. The "Add to Preferred Sources" pills, in the hero and above the newsletter. The .btnwrap
        this build injects is 238px and correctly centred (centre 195 on a 390 viewport), but
        Google's widget renders 218px flush left inside it, leaving 20px dead on the right — so
        the visible pill sat at centre 185, 10px left of everything above it. Making .btnwrap a
        centring flex box puts the widget's own 218 in the middle of the 238: centre 195, off 0.
        The wrapper's 238 width is left as it is, since the desktop nav copy depends on it.

     Checked and NOT changed, both of which a naive symmetry sweep flags as false positives:
     "View all case studies" is centred once its trailing arrow is counted (the text alone looks
     13px left because the arrow adds 26px on the right), and "View all posts" is deliberately
     left-aligned inside the purple blog card, matching that card's own copy.

     Verified: phone button 0/46.3 -> 23.2/23.2, both pills centre 185 -> 195. At 1280 every one
     of these measures identical with and without the block — the hero button still gapL 0, the
     footer pill still centre 782.8, and the mobile pill is display:none there anyway. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-yux2lw-container {
      margin-left: auto;
      margin-right: auto;
    }
    .vaeral-mob-prefsrc .btnwrap,
    .vaeral-foot-prefsrc .btnwrap {
      display: flex;
      justify-content: center;
    }
  }

  /* --- Get in Touch card's left padding on phone --------------------------------------------
     The card holding "Get in Touch", the email, the phone and the social icons is padded
     20px on three sides and 8px on the fourth. The export's phone-variant rule is

       .framer-cTzwY.framer-v-1a63o24 .framer-4m1h3r { padding: 20px 20px 20px 8px }

     so its contents sat 12px closer to the left edge than to the right, which is what reads as
     the block being shoved left inside its own card. Desktop has no such rule and uses a plain
     20px all round, so this is a phone-only slip rather than a deliberate asymmetry.

     20px is therefore the card's OWN value, taken from its other three sides and from what it
     uses at every other width. Nothing else about the card changes, and the contents stay
     left-aligned as designed — they are simply inset by the same amount as everything else.

     The selector needs three classes to land. The export's rule is (0,3,0) and a two-class
     override is silently outranked — measured: with .framer-ofgoy .framer-4m1h3r the gap stayed
     at 8px. Matching the specificity and relying on source order (this block is injected at the
     end of the document, after the export's own stylesheet) is what makes it apply.

     NOTE: never write the literal body-closing tag inside these comments. Several patches in
     this file inject by replacing the FIRST occurrence of it, so a copy sitting in a style
     comment silently captures the injection — that is exactly how the runtime image re-assert
     script ended up inside a <style> block and the two homepage illustrations broke.

     Verified on the live page at 390: left gap 8 -> 20, matching the 20 the same rows already
     have at 1280, and the 1280 gaps are unchanged. */
  @media (max-width: 809.98px) {
    .framer-ofgoy .framer-v-1a63o24 .framer-4m1h3r { padding-left: 20px; }
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

// The card's label colour and its box are set in HOMEPAGE_FIX_STYLES now: with the outlined
// pill gone there is no Framer --border-* box to reproduce, and a plain CSS border works here
// exactly as it does on the preferred-source card.

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

// The lede's count comes from the array so it cannot go stale when a service is added; the
// build already refuses to run if that count and SERVICES_DISPLAY_ORDER disagree.
const COUNT_WORDS = { 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Eleven', 12: 'Twelve' };

function servicesLede(n) {
  return `${COUNT_WORDS[n] || n} ways we shape what buyers and answer engines find about your brand.`;
}

// The hook is the first sentence of the service's own description — the claim, without the
// "How Vaeral ..." half that follows it. Their copy, split at the sentence boundary, so the
// homepage cannot drift from the service page the way a second hand-written line would.
function serviceHook(s) {
  const desc = (s.description || '').trim();
  if (!desc) return '';
  const first = desc.split('. ')[0];
  return first === desc ? desc : `${first}.`;
}

// One line-icon per service, drawn rather than fetched: a sprite would be another request and
// an emoji is not a mark. Stroke-only on currentColor so the ring's colour drives them, and
// aria-hidden because the service name beside each one is already the link's text.
const SERVICE_ICON_PATHS = {
  'review-management': '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"/>',
  'brand-search-results': '<circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2L20 20"/><path d="M7.6 9.6h5.8M7.6 12.4h3.4"/>',
  'comment-management': '<path d="M4 5.5h11a2 2 0 012 2v5a2 2 0 01-2 2H9l-4 3v-3H4a1 1 0 01-1-1v-6a2 2 0 011-2z"/><path d="M19 9.5h1a1 1 0 011 1v6a1 1 0 01-1 1h-1v2.5l-3-2.5"/>',
  'reddit-marketing': '<path d="M12 19V6"/><path d="M7 11l5-5 5 5"/><path d="M5 21h14"/>',
  'quora-marketing': '<circle cx="12" cy="12" r="8.4"/><path d="M9.7 9.6a2.4 2.4 0 114.1 1.8c-.9.8-1.7 1.2-1.7 2.3"/><path d="M12 17.2h.01"/>',
  'ai-search-visibility': '<path d="M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9L5.2 10.3l4.9-1.9z"/><path d="M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  'wikipedia-page-creation': '<path d="M12 7.2C10.4 5.9 8.4 5.3 4.5 5.3v12c3.9 0 5.9.6 7.5 1.9 1.6-1.3 3.6-1.9 7.5-1.9v-12c-3.9 0-5.9.6-7.5 1.9z"/><path d="M12 7.2v11.9"/>',
  'linkedin-personal-branding': '<rect x="3.5" y="4.8" width="17" height="14.4" rx="2.4"/><circle cx="9" cy="11" r="2.1"/><path d="M5.8 16.4c.5-1.6 1.8-2.4 3.2-2.4s2.7.8 3.2 2.4"/><path d="M14.8 10.4h3.4M14.8 13.4h3.4"/>',
  'influencer-marketing': '<path d="M4 10.2v3.6a1.6 1.6 0 001.6 1.6h2L14 19V5l-6.4 3.6h-2A1.6 1.6 0 004 10.2z"/><path d="M17.4 9.2a4 4 0 010 5.6"/><path d="M19.8 6.8a7.4 7.4 0 010 10.4"/>',
  'app-store-growth': '<path d="M12 4v9.4"/><path d="M8.2 10.2L12 14l3.8-3.8"/><path d="M4.5 16.4v1.6a2 2 0 002 2h11a2 2 0 002-2v-1.6"/>'
};

function serviceIcon(slug) {
  const d = SERVICE_ICON_PATHS[slug];
  if (!d) throw new Error(`serviceIcon: no icon for "${slug}" — add one so the row is not blank`);
  return (
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    d +
    '</svg>'
  );
}

// No <h1> anywhere in here: render-check compares the first hydrated <h1> against the first
// served one, so an <h1> inserted above the hero's would fail that check even with hydration
// working correctly.
function servicesSectionHtml(services) {
  const items = orderedServices(services)
    .map((s) => {
      const hook = serviceHook(s);
      return (
        `<a class="${SERVICES_SECTION_CLASS}-item" href="/services/${s.slug}">` +
        `<span class="${SERVICES_SECTION_CLASS}-halo">` +
        `<span class="${SERVICES_SECTION_CLASS}-ring">${serviceIcon(s.slug)}</span>` +
        `</span>` +
        `<span>` +
        `<span class="${SERVICES_SECTION_CLASS}-name">${escapeHtml(serviceLabel(s))}</span>` +
        (hook ? `<span class="${SERVICES_SECTION_CLASS}-hook">${escapeHtml(hook)}</span>` : '') +
        `</span>` +
        `</a>`
      );
    })
    .join('');

  return (
    `<section class="${SERVICES_SECTION_CLASS}">` +
    `<div class="${SERVICES_SECTION_CLASS}-inner">` +
    `<div class="${SERVICES_SECTION_CLASS}-head">` +
    `<div class="${SERVICES_SECTION_CLASS}-headtext">` +
    `<div class="${SERVICES_SECTION_CLASS}-h2">` +
    `<h2 class="framer-text framer-styles-preset-398jw4" data-styles-preset="QnZFqE78z" dir="auto" style="--framer-text-alignment:left">Our Services</h2>` +
    `</div>` +
    `<p class="${SERVICES_SECTION_CLASS}-lede">${escapeHtml(servicesLede(services.length))}</p>` +
    `</div>` +
    `<a class="${SERVICES_SECTION_CLASS}-cta" href="/services">` +
    `<span class="framer-text framer-styles-preset-hj0x3x" data-styles-preset="G4spYZp3J" dir="auto" style="--framer-text-color:var(--token-05f7c79d-9f6d-455d-9542-2f5b1e17e42e, rgb(222, 221, 255))">See all services</span>` +
    `</a>` +
    `</div>` +
    `<div class="${SERVICES_SECTION_CLASS}-grid">${items}</div>` +
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
    width: calc(100% - 48px); max-width: 820px;
    /* The card lands straight after the article body, so it needs its own air above —
       without it the border sat on the last line of the post. 48px matches the blog index. */
    margin: 48px auto 8px;
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
    .${PREFERRED_SOURCE_CLASS} { width: calc(100% - 32px); padding: 18px; margin-top: 32px; }
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

// Defers every image that is not painted in the first viewport.
//
// Measured on the built homepage: 85 <img> tags in the file, 50 of them render at 390px, and
// exactly THREE sit above the fold — and the same three at 1280px too: the nav logo, the hero
// plate and the hero's secondary mark. The other 47 were all eager, so a phone downloaded about
// 1.3MB of off-screen artwork in competition with the image that decides LCP.
//
// The eager set is keyed off the file stems rather than position, because the export ships up to
// three breakpoint variants of each block and DOM order does not match visual order. Keying on
// the stem keeps the right images eager at every breakpoint without having to know which variant
// is the visible one. Anything the head preloads must also stay eager, or the preload and the
// lazy attribute fight and the browser fetches it twice.
//
// decoding="async" rides along so a large image cannot block the main thread while it paints.
// Images that already declare loading= are left exactly as they are.
const EAGER_IMAGE_STEMS = [
  'vaeral-logo.svg',             // nav logo, served from /assets
  'mxApJNEyaqa0EEnfiAbWSEiVOo',  // nav logo, the framerusercontent copy the runtime swaps in
  'ui8KS5G13xZLHx95GVXLocBVlU',  // hero plate, the LCP element
  'XzBd4KoG4q2LxAWIl0U4GPAz2c',  // hero secondary mark
];

function lazyLoadBelowFold(html) {
  let lazied = 0, kept = 0;
  const out = html.replace(/<img(?![a-zA-Z])[^>]*>/g, (tag) => {
    if (/\sloading\s*=/.test(tag)) { kept++; return tag; }
    if (EAGER_IMAGE_STEMS.some((stem) => tag.includes(stem))) { kept++; return tag; }
    lazied++;
    const withDecoding = /\sdecoding\s*=/.test(tag) ? tag : tag.replace(/^<img(?![a-zA-Z])/, '<img decoding="async"');
    return withDecoding.replace(/^<img(?![a-zA-Z])/, '<img loading="lazy"');
  });
  if (!lazied) throw new Error('lazyLoadBelowFold: no images were deferred — the markup changed shape');
  console.log(`  ✓ deferred ${lazied} below-fold images (${kept} kept eager)`);
  return out;
}

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
    '<p class="nudge">Click Me <span class="arw" aria-hidden="true">&#8594;</span></p>' +
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

<style>
/* --- Play Store card: give it the sliding bar the other two cards have --------------------
   The three "One post. One thread." cards each show a glowing bar sweeping down as the card
   scrolls in. The Reddit and Quora cards carry that bar as a SEPARATE image layer over their
   artwork, which is why it can move. The Play Store card never had one: its red bar and the
   arrow badge are painted into the artwork PNG, so nothing could animate. The June 2026 mirror
   of the site has the same structure, so this was never a regression.

   Fixed by splitting that PNG in two. The source is Framer's
   jR3xO4UqNnOFOYBwWcdiZoSo4Uk.png at 1152x1073; if it is ever republished, both files below
   have to be regenerated from it or the card will show stale art. Both keep the source's own
   1152:1073 aspect so background-size:cover maps them identically:
     playstore-card.webp     the artwork with the bar removed and the band behind it rebuilt
     playstore-scanbar.webp  the bar and badge alone, on transparency

   The plate replaces the artwork through the wrapper's background rather than by swapping the
   img src, because Framer rehydrates this page and rebuilds img attributes from its own chunk;
   a background on the wrapper is CSS and survives. The img stays for layout and alt text at
   opacity 0.

   Travel is 150px, the distance the other two bars move, and overflow:hidden on the artwork
   box clips the bar while it is still above its resting place. */
.framer-ofgoy .framer-6w8gru .framer-153kduw { overflow: hidden; }
.framer-ofgoy .framer-6w8gru .framer-153kduw [data-framer-background-image-wrapper] {
  background-image: url("/assets/playstore-card.webp");
  background-size: cover;
  background-position: center;
}
.framer-ofgoy .framer-6w8gru .framer-153kduw [data-framer-background-image-wrapper] > img { opacity: 0; }
/* Position and opacity come from two custom properties the script drives, NOT from a CSS
   animation. A CSS animation here stays play-pending until the element gets a clean rendering
   opportunity, and the surrounding Framer appear animations saturate the main thread for about
   390ms as this section arrives, so the sweep latched its clock that much after the other two
   and visibly trailed them. Framer drives its own bars from rAF, so doing the same is the only
   way the three stay in step. The properties live on :root because every element in this
   subtree has its inline style rewritten by Framer's renderer. */
.framer-ofgoy .framer-6w8gru .framer-153kduw [data-framer-background-image-wrapper]::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("/assets/playstore-scanbar.webp");
  background-size: cover;
  background-position: center;
  pointer-events: none;
  opacity: var(--vaeral-ps-o, 0);
  transform: translateY(var(--vaeral-ps-y, -150px));
}
</style>
<script>
(function () {
  var root = document.documentElement, t0 = null, stall = null, parked = false;

  function set(y, o) {
    root.style.setProperty('--vaeral-ps-y', y.toFixed(2) + 'px');
    root.style.setProperty('--vaeral-ps-o', o.toFixed(4));
  }
  // The export ships hidden breakpoint copies of every element, so a bare querySelector can
  // return one that is not laid out and never animates.
  function shown(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].getBoundingClientRect().width > 0) return list[i];
    }
    return null;
  }

  // One loop for the life of the page, and NOTHING latches. Framer replays its bars every time
  // the section comes back into view, so a sweep that completed once and stayed finished was the
  // only one in the row that did not replay on the way back up.
  //
  // Side by side, which is the only case where two of these bars are on screen together, this
  // COPIES the Reddit card's bar frame by frame. Matching Framer by hand does not hold: its
  // trigger point moves with the breakpoint (that card was 57%, 34% and 82% visible at 1440,
  // 1024 and 390 when it fired), so a threshold read at one width is wrong at the others.
  // Copying cannot drift and it needs no trigger, because before Framer moves its bar this one
  // simply tracks it where it rests.
  //
  // Deliberately NOT gated on prefers-reduced-motion. Framer ignores the preference for its own
  // two bars and cannot be stopped from here, so honouring it reduced no motion; it just made
  // this the only static bar in a moving row. Copying means that if Framer ever does honour it,
  // this bar stays put too.
  function frame(ts) {
    var card = shown(document.querySelectorAll('.framer-6w8gru'));
    if (card) {
      var rect = card.getBoundingClientRect();
      // Only do the per-frame reads near the section; elsewhere this is one rect and out.
      if (rect.bottom > -700 && rect.top < window.innerHeight + 700) {
        parked = false;
        var peer = shown(document.querySelectorAll('.framer-1x6b0po'));
        var ref = peer && shown(peer.querySelectorAll('.framer-1kvqo5m'));
        if (peer && ref && Math.abs(peer.getBoundingClientRect().top - rect.top) < 24) {
          // Re-resolved every frame: Framer swaps these nodes on hydration, and a reference held
          // from before comes back with an empty computed style, which froze the bar in place.
          var cs = getComputedStyle(ref);
          var o = parseFloat(cs.opacity);
          if (isNaN(o)) o = 0;
          var m = cs.transform.match(/matrix\(([^)]*)\)/);
          if (m) {
            set(parseFloat(m[1].split(',')[5]), o);
            // If the reference never moves while the card sits in view, show the bar anyway
            // rather than leave it hidden above its resting place.
            if (o > 0.001) stall = null;
            else if (rect.top < window.innerHeight) {
              if (stall === null) stall = ts;
              else if (ts - stall > 4000) set(0, 1);
            }
          }
          t0 = null;
        } else {
          // Stacked, where the card arrives alone: its own 1.6s symmetric ease-in-out, both
          // measured off that same Reddit bar. Held at the start until the card is half showing.
          if (t0 === null) {
            if (rect.top > window.innerHeight - rect.height * 0.5) {
              set(-150, 0);
              requestAnimationFrame(frame);
              return;
            }
            t0 = ts;
          }
          var x = Math.min(1, (ts - t0) / 1600);
          var e = x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
          set(-150 * (1 - e), e);
        }
      } else {
        // Out of range. Re-arm AND put the bar back at its start, so the next approach replays
        // from the top the way the other two do rather than resuming from where it was frozen.
        t0 = null;
        stall = null;
        if (!parked) { set(-150, 0); parked = true; }
      }
    }
    requestAnimationFrame(frame);
  }

  function begin() {
    // Fetch both halves up front. The section is far down the page, so warming the cache here
    // costs nothing by the time anyone scrolls to it.
    ['/assets/playstore-card.webp', '/assets/playstore-scanbar.webp'].forEach(function (u) {
      var i = new Image();
      i.src = u;
    });
    requestAnimationFrame(frame);
  }
  if (document.body) begin();
  else document.addEventListener('DOMContentLoaded', begin);
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

const PHONE_OLD = '+91 9104491177';
const PHONE_NEW = '+91 9707648973';

// The number is in the Framer export's markup three times per page (one per SSR variant), and
// again inside the footer module the page hydrates from, so replacing the markup alone holds
// only until hydration puts the old number back. Same shape as the nav fix above: correct the
// markup so the first paint is right, then re-assert in the DOM and keep re-asserting.
const PHONE_SCRIPT = `
<script>
(function () {
  var OLD = ${JSON.stringify(PHONE_OLD)}, NEW = ${JSON.stringify(PHONE_NEW)}, busy = false;
  function run() {
    if (busy) return;
    busy = true;
    try {
      var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), node;
      while ((node = walk.nextNode())) {
        if (node.nodeValue.indexOf(OLD) > -1) node.nodeValue = node.nodeValue.split(OLD).join(NEW);
      }
    } finally {
      busy = false;
    }
  }
  function start() {
    run();
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
</script>`;

// Every page that shows the number: fix the markup, and carry the re-assertion script.
function patchPhone(html) {
  if (!html.includes(PHONE_OLD)) return html;
  return html.split(PHONE_OLD).join(PHONE_NEW).replace('</body>', `${PHONE_SCRIPT}</body>`);
}

// Both form scripts, at module scope so EVERY page gets them, not just the homepage.
// The Framer export wires its forms to Framer's own backend, so any form that these do not
// take over posts to api.framer.com and mails the Framer account instead of reaching us,
// skipping the blocklist, the rate limit and the honeypots in api/contact.js. They were only
// injected into the homepage, so the newsletter field on /about, the service pages and the
// landing pages had been submitting to Framer all along.
// Both are idempotent: they mark the form with a data attribute and skip it next time.
const CONTACT_FORM_SCRIPT = `
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

const NEWSLETTER_FORM_SCRIPT = `
<script>
(function() {
  setInterval(function() {
    // Matched by SHAPE, not by class. The export uses a different generated class per newsletter
    // placement (framer-w8wwxz in the page footer, framer-ushtcb on blog posts), so a class list
    // silently misses any new one and that form goes back to posting at Framer. Anything with an
    // email field and no name or phone field is a newsletter; the contact form is excluded by
    // both tests.
    var forms = [].slice.call(document.querySelectorAll('form')).filter(function(f) {
      if (f.dataset.vaeralInjected) return false;
      if (f.querySelector('input[name="Name"], input[name="Phone"]')) return false;
      return !!f.querySelector('input[type="email"]');
    });
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

// Set by buildFormChunks before any page is written; every page is pointed at our copies.
let FORM_CHUNK_MAP = null;

function writePage(dir, html) {
  fs.mkdirSync(dir, { recursive: true });
  // Nav anchors are relative in the Framer export and resolve against the current
  // page, which breaks them everywhere except the homepage. Rewrite to absolute,
  // and re-assert at runtime since hydration reverts DOM changes.
  const patched = hasFramerNav(html)
    ? patchNavHrefs(html).replace('</body>', `${NAV_SCRIPT}</body>`)
    : html;
  if (!FORM_CHUNK_MAP) throw new Error('writePage ran before the Framer form chunks were built');
  const noFramer = applyFormChunkMap(patched, FORM_CHUNK_MAP);
  const withForms = noFramer.includes('</body>')
    ? noFramer.replace('</body>', CONTACT_FORM_SCRIPT + NEWSLETTER_FORM_SCRIPT + '</body>')
    : noFramer;
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    patchImages(patchPhone(withForms).replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com')),
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

// The blog post export predates the site's darker page background: it paints the page from the
// navy surface token (#040128) while every newer export — case studies, services, about, and the
// homepage itself — uses a literal rgb(2,1,10). That left /blog/* visibly lighter than the rest of
// the site. Repoint just the two page-background declarations; the token stays as it is because
// the navy is still the right colour for the things that actually use it (buttons, the nav card).
function matchPageBackground(html, label) {
  const swaps = [
    ['body { background: var(%TOKEN%, rgb(4, 1, 40)); }', 'body { background: rgb(2, 1, 10); }'],
    ['background-color:var(%TOKEN%,#040128)', 'background-color:#02010a'],
  ];
  for (const [from, to] of swaps) {
    const needle = from.replace('%TOKEN%', '--token-fc3c6bee-17cf-410b-a413-566e16934a0b');
    const n = html.split(needle).length - 1;
    if (n !== 1) throw new Error(`${label}: expected the page background "${needle}" once, found ${n} — re-check the export`);
    html = html.replace(needle, to);
  }
  // Those two fix what the browser paints before the page hydrates. Framer's runtime then
  // re-applies its own body rule from the CDN modules and the navy comes back — the root div
  // still covers the page so it only shows as a navy edge on overscroll, but pin it anyway.
  // !important beats the runtime's plain declaration whichever order the two land in.
  return html.replace('</body>', '<style>body{background:#02010a!important}</style></body>');
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
  html = matchPageBackground(html, `blog/${a.slug}`);
  
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
    '> across Reddit, Quora, LinkedIn and AI search. Founded 2020, based in Guwahati,',
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
    '- Founded: 2020',
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
  const teamMembers = buildTeamWheelChunk({ root: ROOT, distAssets: DIST_ASSETS });
  FORM_CHUNK_MAP = buildFormChunks({ root: ROOT, distAssets: DIST_ASSETS });
  console.log(`  ✓ team wheel chunk: ${teamMembers} members`);

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



    if (indexHtml.includes('</body>')) {
      indexHtml = indexHtml.replace('</body>', styleFix + HOMEPAGE_FIX_STYLES + NAV_PREFERRED_SOURCE_STYLES + blogNavScript + CASE_STUDIES_CTA_SCRIPT + servicesSectionScript(publishedServices) + NAV_PREFERRED_SOURCE_SCRIPT + CONTACT_FORM_SCRIPT + NEWSLETTER_FORM_SCRIPT + '</body>');
    }

    // Preloads are split by breakpoint with the media attribute, so each width fetches only what
    // it actually paints first and NEITHER inherits the other's list.
    //
    // Desktop and tablet (>=810px) keep the original four, unchanged, byte for byte. That list
    // predates this work and desktop is not ours to retune.
    //
    // Phone (<=809.98px) gets its own pair. Measured on the built page at 390x664, exactly three
    // images sit above the fold: the nav logo (inline-sized, arrives with the document) plus the
    // hero plate (ui8KS) and the hero's secondary mark (XzBd4). Of the original four only ui8KS
    // is one of them, so on a phone the other three were being fetched at the highest priority
    // ahead of the element that decides LCP — n2ZMsJ worst of all, a 6000x4000 source.
    const preloads = `
<link rel="preload" as="image" media="(min-width: 810px)" href="https://framerusercontent.com/images/r0nnngidlqmFQKjVhqENbu42IA.png?width=1316&height=574">
<link rel="preload" as="image" media="(min-width: 810px)" href="https://framerusercontent.com/images/sNKeQAU4GFrqfgvCqAIvZCU1KRA.png?scale-down-to=1024&width=1161&height=1080">
<link rel="preload" as="image" media="(min-width: 810px)" href="https://framerusercontent.com/images/n2ZMsJIF5MgwK89prVzJKbCUcS0.jpg?scale-down-to=1024&width=6000&height=4000">
<link rel="preload" as="image" media="(min-width: 810px)" href="https://framerusercontent.com/images/ui8KS5G13xZLHx95GVXLocBVlU.png?width=527&height=895">
<link rel="preload" as="image" media="(max-width: 809.98px)" href="https://framerusercontent.com/images/ui8KS5G13xZLHx95GVXLocBVlU.png?width=527&height=895">
<link rel="preload" as="image" media="(max-width: 809.98px)" href="https://framerusercontent.com/images/XzBd4KoG4q2LxAWIl0U4GPAz2c.png?scale-down-to=1024">
`;
    // loading="lazy" is baked into the markup for every below-fold image, and HTML gives no way
    // to scope an attribute to a breakpoint. Desktop is not ours to retune, so above 810px the
    // attribute is taken back off again before it can take effect.
    //
    // This has to run BEFORE the body parses, or the browser has already decided to defer and
    // removing the attribute just triggers a late fetch. A script at the end of <head> runs
    // first, and the observer then strips the attribute off each <img> as the parser inserts it.
    // It disconnects at DOMContentLoaded and does one final sweep, so it costs a desktop visitor
    // one observer for the duration of the parse and nothing afterwards.
    //
    // The query matches the phone breakpoint used everywhere else in this file, so a phone keeps
    // every lazy attribute and this code returns immediately.
    const desktopEagerScript = `
<script>
(function () {
  if (window.matchMedia('(max-width: 809.98px)').matches) return;
  var strip = function (root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'IMG') { root.removeAttribute('loading'); return; }
    if (root.querySelectorAll) {
      var found = root.querySelectorAll('img[loading]');
      for (var i = 0; i < found.length; i++) found[i].removeAttribute('loading');
    }
  };
  var obs = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) strip(added[j]);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', function () {
    obs.disconnect();
    strip(document.body);
  });
})();
<\/script>
`;
    if (indexHtml.includes('</head>')) {
      indexHtml = indexHtml.replace('</head>', preloads + desktopEagerScript + '</head>');
    }

    indexHtml = lazyLoadBelowFold(indexHtml);
    indexHtml = patchHomepageCopy(indexHtml);
    indexHtml = patchHomepageCaseStudiesCta(indexHtml);
    indexHtml = patchHomepageServices(indexHtml, publishedServices);
    indexHtml = patchHomepageTeam(indexHtml);
    indexHtml = applyFormChunkMap(indexHtml, FORM_CHUNK_MAP);
    indexHtml = patchHomepageSeo(indexHtml);
    indexHtml = patchNavHrefs(indexHtml, { isHomepage: true });
    indexHtml = disableSPARouting(indexHtml, true);
    fs.writeFileSync(indexFile, patchImages(patchPhone(indexHtml).replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com')));
    console.log(`  ✓ patched dist/index.html: SEO head tags, SPA routing, LCP preloads`);
  }

  // Nothing ships with a Framer form endpoint in it. See framer-forms.js.
  assertNoFramerForms(DIST);
  console.log(`\nBuild complete: ${publishedPosts.length} posts, ${cases.filter((c) => !c.attributes.draft).length} case studies.`);
}

main();
