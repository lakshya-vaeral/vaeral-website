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

function writePage(dir, html) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
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
};

function restyle(html, presets) {
  if (!html || !html.trim()) return '';
  const $ = cheerio.load(html, cheerioOpts, false);

  // Framer wraps each list item's content in a <p>; marked only does so for "loose"
  // lists. Normalise so every <li> has an inner <p> we can style.
  if (presets.li) {
    $('li').each((_, el) => {
      const $li = $(el);
      if ($li.children('p').length === 0) $li.html(`<p>${$li.html()}</p>`);
    });
  }

  const order = ['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'a', 'strong', 'em'];
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

function buildBlogPost({ attributes: a, body }) {
  const url = `${SITE}/blog/${a.slug}`;
  const hero = { src: a.coverImage || '/assets/og-image.png', alt: a.coverAlt || a.title, ...imageSize(a.coverImage) };
  let html = fill(fs.readFileSync(path.join(TEMPLATES, 'blog.html'), 'utf8'), {
    TITLE: escapeHtml(a.title),
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
    BODY: restyle(marked.parse(body), BLOG_PRESETS),
  });
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

  html = disableSPARouting(html);
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
    DESCRIPTION: escapeHtml(a.description),
    OG_IMAGE: escapeHtml(absImage(a.coverImage)),
    URL: escapeHtml(url),
    CATEGORY: escapeHtml(a.category),
    TAGS: renderChips(a.tags),
    PROBLEM: restyle(marked.parse(a.problem || ''), CASE_PRESETS),
    WHATWEDID: restyle(marked.parse(a.whatWeDid || ''), CASE_PRESETS),
    RESULTS: restyle(marked.parse(a.results || ''), CASE_PRESETS),
  });
  html = disableSPARouting(html);
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
    TITLE: escapeHtml('Case Studies — Vaeral'),
    URL: escapeHtml(`${SITE}/casestudies`),
    CASES: cards,
  });
  writePage(path.join(DIST, 'casestudies'), disableSPARouting(html));
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
    TITLE: escapeHtml('Blog — Vaeral'),
    URL: escapeHtml(`${SITE}/blog`),
    POSTS: cards,
  });
  writePage(path.join(DIST, 'blog'), disableSPARouting(html));
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
    publishedPosts.push(buildBlogPost(entry));
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

  buildBlogIndex(publishedPosts);
  console.log(`  ✓ blog listing -> dist/blog/index.html (${publishedPosts.length} posts)`);
  
  buildCaseStudyIndex(publishedCases);
  console.log(`  ✓ case study listing -> dist/casestudies/index.html (${publishedCases.length} case studies)`);

  // Force hard navigation for all internal links on the homepage to bypass Framer SPA router
  const indexFile = path.join(DIST, 'index.html');
  if (fs.existsSync(indexFile)) {
    let indexHtml = fs.readFileSync(indexFile, 'utf8');

    // Robust injection: use CSS to prevent overflow clipping and JS to inject the button AFTER React hydrates.
    const styleFix = `\\n<style>\\n  html, body, div, h1, h2, h3, h4, h5, h6, p, span, a, section, article, img { -webkit-user-select: none !important; user-select: none !important; }\\n  input, textarea, [contenteditable] { -webkit-user-select: auto !important; user-select: auto !important; }\\n  [contenteditable]:not(input):not(textarea) { -webkit-user-modify: read-only !important; user-modify: read-only !important; caret-color: transparent !important; }\\n</style>\\n`;
    const jsFix = `\\n<script>\\n  const observer = new MutationObserver(() => {\\n    document.querySelectorAll('[contenteditable]').forEach(el => {\\n      el.removeAttribute('contenteditable');\\n    });\\n  });\\n  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });\\n\\n  setInterval(() => {\\n    const grid = document.querySelector('.framer-fbd1z7');\\n    if (grid && !document.querySelector('.casestudy-btn-injected')) {\\n      const buttonHtml = \\\`<div class="casestudy-btn-injected framer-11slc2n-container" style="margin-top: 40px; display: flex; justify-content: center; width: 100%; position: relative; z-index: 999;"><a class="framer-7W2hy framer-HSXLe framer-1r2rpbk framer-v-1r2rpbk framer-wrl6m0" data-framer-name="Variant 1" target="_top" href="/casestudies"><div class="framer-12d9ns1" data-framer-component-type="RichTextContainer" style="--extracted-r6o4lv:var(--token-e374d95c-0883-47b0-9f7c-6ff189c778da, rgb(255, 255, 255));--framer-link-text-color:rgb(0, 153, 255);--framer-link-text-decoration:underline;transform:none"><p class="framer-text framer-styles-preset-hj0x3x" data-styles-preset="G4spYZp3J" style="--framer-text-color:var(--extracted-r6o4lv, var(--token-e374d95c-0883-47b0-9f7c-6ff189c778da, rgb(255, 255, 255)))">View all Case Studies</p></div><div data-framer-component-type="SVG" data-framer-name="Icon" parentsize="0" rotation="0" class="framer-1b8vfkj" aria-hidden="true" style="image-rendering:pixelated;flex-shrink:0;background-size:100% 100%;background-image:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 xmlns:xlink=%22http://www.w3.org/1999/xlink%22 viewBox=%220 0 16 14%22><path d=%22M 15.206 7.331 L 9.581 12.956 C 9.398 13.139 9.102 13.139 8.919 12.956 C 8.736 12.773 8.736 12.477 8.919 12.294 L 13.743 7.469 L 1.125 7.469 C 0.866 7.469 0.656 7.259 0.656 7 C 0.656 6.741 0.866 6.531 1.125 6.531 L 13.743 6.531 L 8.919 1.706 C 8.755 1.52 8.764 1.239 8.939 1.064 C 9.114 0.889 9.395 0.88 9.581 1.044 L 15.206 6.669 C 15.388 6.852 15.388 7.148 15.206 7.331 Z%22 fill=%22rgb(255,255,255)%22></path></svg>')"></div></a></div>\\\`;\\n      grid.insertAdjacentHTML('afterend', buttonHtml);\\n    }\\n\\n    const contactLinks = document.querySelectorAll('nav a[href="#contact"]');\\n    contactLinks.forEach(contactLink => {\\n      if (contactLink.textContent.trim() !== 'Contact') return;\\n      const container = contactLink.parentElement;\\n      if (container && (!container.nextElementSibling || !container.nextElementSibling.classList.contains('nav-blog-injected'))) {\\n        const newContainer = container.cloneNode(true);\\n        newContainer.classList.add('nav-blog-injected');\\n        // Remove fixed positioning or widths that might break layout\\n        newContainer.style.position = 'relative';\\n        newContainer.style.left = 'auto';\\n        newContainer.style.right = 'auto';\\n        newContainer.style.transform = 'none';\\n        const newLink = newContainer.querySelector('a');\\n        if (newLink) {\\n          newLink.setAttribute('href', '/blog');\\n          newLink.setAttribute('target', '_top');\\n          const walker = document.createTreeWalker(newLink, NodeFilter.SHOW_TEXT, null, false);\\n          let node;\\n          while (node = walker.nextNode()) {\\n            if (node.nodeValue.includes('Contact')) {\\n              node.nodeValue = node.nodeValue.replace('Contact', 'Blogs');\\n            }\\n          }\\n        }\\n        container.insertAdjacentElement('afterend', newContainer);\\n        // Make sure parent flexbox allows it to fit\\n        if (container.parentElement) {\\n          container.parentElement.style.flexWrap = 'nowrap';\\n          container.parentElement.style.overflow = 'visible';\\n          container.parentElement.style.gap = '15px';\\n          container.parentElement.style.minWidth = 'max-content';\\n        }\\n      }\\n    });\\n  }, 500);\\n</script>\\n`;
    
    if (indexHtml.includes('</body>')) {
      indexHtml = indexHtml.replace('</body>', styleFix + jsFix + '</body>');
    }

    indexHtml = disableSPARouting(indexHtml, true);
    fs.writeFileSync(indexFile, indexHtml);
    console.log(`  ✓ patched dist/index.html to disable SPA routing site-wide`);
  }

  console.log(`\nBuild complete: ${publishedPosts.length} posts, ${cases.filter((c) => !c.attributes.draft).length} case studies.`);
}

main();
