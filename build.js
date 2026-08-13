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

// Colour and typography for CMS content come from the Framer presets in CASE_PRESETS, the
// same route every other injected tag uses. What the export has no rules for at all is
// table *structure* — it never contained a table — so a bare markdown table renders with
// collapsed spacing and no separators. This adds only that: geometry and rules, no colour.
// Scoped to RichTextContainer so it can only affect injected content.
const CONTENT_STYLES = `
<style>
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
</style>
</head>`;

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

const BLOG_PRESETS = {
  p: { class: 'framer-text framer-styles-preset-dg89m0' },
  h2: { class: 'framer-text framer-styles-preset-398jw4', wrapStrong: true },
  h3: { class: 'framer-text framer-styles-preset-1tx2fj3', wrapStrong: true },
  h4: { class: 'framer-text framer-styles-preset-1t2dmrb', wrapStrong: true },
  h5: { class: 'framer-text framer-styles-preset-1t2dmrb', wrapStrong: true },
  h6: { class: 'framer-text framer-styles-preset-1t2dmrb', wrapStrong: true },
  a: { class: 'framer-text framer-styles-preset-s7x4xb', attrs: { target: '_blank', rel: 'noopener' } },
  strong: { class: 'framer-text' },
  em: { class: 'framer-text' },
  ul: { class: 'framer-text' },
  ol: { class: 'framer-text' },
  li: { class: 'framer-text framer-styles-preset-dg89m0', attrs: { 'data-preset-tag': 'p' }, innerPClass: 'framer-text framer-styles-preset-dg89m0' },
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
        },
      }),
      schema.breadcrumbList([
        { name: 'Home', url: `${SITE}/` },
        { name: 'Blog', url: `${SITE}/blog` },
        { name: a.title, url },
      ]),
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
      // article:author is intentionally absent: owner declined personal bylines
      // (2026-07-27). Putting the organisation name in this field would be read
      // as a person, so it is omitted rather than filled with the wrong entity.
    ].join('\n    '),
  );

  // Also rewrite the Framer CMS record so client hydration renders this post, not the template's.
  html = patchBlogHandover(html, a, body, hero);
  
  // Inject CSS to disable the sticky scroll effect on the Newsletter box
  html = html.replace('</head>', `
<style>
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
  html = injectContentStyles(stripFramerPageRuntime(disableSPARouting(html)));
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

// Service pages and /about reuse the case-study shell rather than introducing new
// UI. Same three rich-text regions, with the section headings supplied by
// frontmatter instead of defaulting to the case-study wording.
function buildStandardPage({ attributes: a }, { dir, breadcrumbParent, schemaType }) {
  const url = `${SITE}/${dir ? `${dir}/` : ''}${a.slug}`;
  const faqHtml = renderFaqs(a.faqs);

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
    PROBLEM: restyle(marked.parse(a.sectionOne || ''), CASE_PRESETS, `${a.slug} section 1`),
    WHATWEDID: restyle(marked.parse(a.sectionTwo || ''), CASE_PRESETS, `${a.slug} section 2`),
    // The FAQ renders inside the third region so the questions are visible page
    // copy — FAQPage schema without visible Q&A breaches Google's policy.
    RESULTS: restyle(marked.parse(a.sectionThree || ''), CASE_PRESETS, `${a.slug} section 3`) + faqHtml,
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
        type: schemaType,
      }),
      a.faqs && a.faqs.length ? schema.faqPage(a.faqs) : null,
      schema.breadcrumbList(
        [
          { name: 'Home', url: `${SITE}/` },
          breadcrumbParent,
          { name: a.title, url },
        ].filter(Boolean),
      ),
    ]),
  });

  html = injectContentStyles(stripFramerPageRuntime(disableSPARouting(html)));
  writePage(path.join(DIST, ...(dir ? [dir] : []), a.slug), html);
  return { slug: a.slug, title: a.title, description: a.description, url };
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

  const description =
    'Reddit, Quora, Wikipedia, LinkedIn, review management and AI search visibility — what each service covers and who it suits.';

  const html = fill(fs.readFileSync(path.join(TEMPLATES, 'case-study-index.html'), 'utf8'), {
    TITLE: escapeHtml('ORM Services: Reddit, Quora & AI Search | Vaeral'),
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
  var ROUTES = { 'About': '/about', 'Case Studies': '/casestudies' };

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
      ({ loc, priority }) =>
        `  <url>\n    <loc>${loc}</loc>\n    <priority>${priority}</priority>\n  </url>`,
    )
    .join('\n');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${urls}\n` +
    '</urlset>\n';
  // No <lastmod>: the only date available is the content's frontmatter date, which
  // is a publish date rather than a modification date. A wrong lastmod is worse
  // than none, since crawlers use it to decide what to re-fetch.
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
  const line = (p, prefix = '') => `- [${p.title}](${SITE}${prefix}/${p.slug})`;

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
    '## Services',
    '',
    ...services.map((s) => line(s, '/services')),
    '',
    '## Case studies',
    '',
    'Client work is described by sector rather than by name.',
    '',
    ...cases.map((c) => line(c)),
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
  const ld = schema.renderJsonLd(schema.organization(SITE));
  if (!html.includes('</head>')) {
    throw new Error('homepage has no </head> — cannot attach structured data');
  }
  html = html.replace('</head>', `${ld}\n</head>`);

  return html;
}

// --- main ------------------------------------------------------------------

function main() {
  fs.mkdirSync(DIST, { recursive: true });

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
    { loc: `${SITE}/`, priority: '1.0' },
    ...publishedPages.map((p) => ({ loc: p.url, priority: '0.8' })),
    { loc: `${SITE}/services`, priority: '0.9' },
    ...publishedServices.map((p) => ({ loc: p.url, priority: '0.9' })),
    { loc: `${SITE}/casestudies`, priority: '0.7' },
    ...publishedCases.map((c) => ({ loc: `${SITE}/${c.slug}`, priority: '0.7' })),
    { loc: `${SITE}/blog`, priority: '0.7' },
    ...publishedPosts.map((p) => ({ loc: `${SITE}/blog/${p.slug}`, priority: '0.6' })),
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
      indexHtml = indexHtml.replace('</body>', styleFix + blogNavScript + contactFormScript + newsletterFormScript + '</body>');
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
    indexHtml = patchHomepageSeo(indexHtml);
    indexHtml = patchNavHrefs(indexHtml, { isHomepage: true });
    indexHtml = disableSPARouting(indexHtml, true);
    fs.writeFileSync(indexFile, patchImages(indexHtml.replace(/https:\/\/vaeral\.com/g, 'https://www.vaeral.com')));
    console.log(`  ✓ patched dist/index.html: SEO head tags, SPA routing, LCP preloads`);
  }

  console.log(`\nBuild complete: ${publishedPosts.length} posts, ${cases.filter((c) => !c.attributes.draft).length} case studies.`);
}

main();
