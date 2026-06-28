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

// Replace every <!--CMS:KEY--> with value (split/join avoids regex-escaping the value).
function fill(template, map) {
  let out = template;
  for (const [key, value] of Object.entries(map)) {
    out = out.split(`<!--CMS:${key}-->`).join(value);
  }
  return out;
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
  const html = fill(fs.readFileSync(path.join(TEMPLATES, 'blog.html'), 'utf8'), {
    TITLE: escapeHtml(a.title),
    DESCRIPTION: escapeHtml(a.description),
    OG_IMAGE: escapeHtml(absImage(a.coverImage)),
    URL: escapeHtml(url),
    DATE: escapeHtml(fmtDate(a.date)),
    DATETIME: escapeHtml(isoDate(a.date)),
    READTIME: escapeHtml(readTimeLabel(a, body)),
    BODY: restyle(marked.parse(body), BLOG_PRESETS),
  });
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
  const html = fill(fs.readFileSync(path.join(TEMPLATES, 'case-study.html'), 'utf8'), {
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
  writePage(path.join(DIST, a.slug), html);
  return { slug: a.slug, title: a.title };
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
  const html = fill(fs.readFileSync(path.join(TEMPLATES, 'blog-index.html'), 'utf8'), {
    TITLE: escapeHtml('Blog — Vaeral'),
    URL: escapeHtml(`${SITE}/blog`),
    POSTS: cards,
  });
  writePage(path.join(DIST, 'blog'), html);
}

// --- main ------------------------------------------------------------------

function main() {
  fs.mkdirSync(DIST, { recursive: true });

  // Ship CMS-uploaded / localized images into the deploy root.
  copyDir(PUBLIC_ASSETS, DIST_ASSETS);

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

  for (const entry of cases) {
    if (entry.attributes.draft) {
      console.log(`  · skip (draft): case-studies/${entry.file}`);
      continue;
    }
    buildCaseStudy(entry);
    console.log(`  ✓ case-study/${entry.attributes.slug} -> dist/${entry.attributes.slug}/index.html`);
  }

  buildBlogIndex(publishedPosts);
  console.log(`  ✓ blog listing -> dist/blog/index.html (${publishedPosts.length} posts)`);

  console.log(`\nBuild complete: ${publishedPosts.length} posts, ${cases.filter((c) => !c.attributes.draft).length} case studies.`);
}

main();
