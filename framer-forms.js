// Take Framer's form backend out of everything this site serves.
//
// The export's forms POST to api.framer.com, which mails the Framer account and skips every
// check in api/contact.js: no blocklist, no rate limit, no honeypot. Our injected scripts already
// intercept each form in the browser, so nothing reaches Framer that way; this is the second
// line, removing the URL from the bundles as well. There are three forms, in three modules:
//
//   the homepage contact form   in the homepage page chunk, patched in team-wheel.js
//   the footer newsletter       in a shared module every page loads
//   the blog newsletter         in a module the blog posts load
//
// The last two are handled here, the same way the team wheel is: a pristine copy is vendored, its
// sibling imports are made absolute so they still come from the CDN, the form URL is swapped, and
// the page loads our copy through an import map. Every count is asserted, so a re-published
// Framer bundle fails the build instead of quietly serving a stale copy.
//
// The replacement is same-origin and fails closed. api/contact.js requires lowercase name, email
// and phone; Framer posts Name, Email and Phone, so if its handler ever did run it would get a
// 400 and nothing would be sent or mailed.
//
// This does NOT close the Framer endpoints. They live on Framer's servers, still accept a direct
// POST from anywhere, and the ids stay readable in Framer's own CDN copies. Only the Framer
// account owner can disable those forms.

import fs from 'node:fs';
import path from 'node:path';

const FRAMER_SITE_CDN = 'https://framerusercontent.com/sites/5p7kq1Z1Vb5AjJ64xQUs96/';
const INERT_ACTION = '/api/contact';

const FORM_CHUNKS = [
  {
    file: 'wNXZ4UOCC.C37vtuCG.mjs',
    local: '/assets/framer/forms-shared.mjs',
    formId: 'd9217efd-f9e7-4858-be2e-98cb4df3708e',
    siblings: 5,
  },
  {
    file: 'KNXn_hn5jbmlorAykcbM5VDWRTMy-jHGnPQO05egfQQ.gYUYwzAr.mjs',
    local: '/assets/framer/forms-blog.mjs',
    formId: 'aeb8dc3c-6aea-4080-b08a-63b2adccd617',
    siblings: 14,
  },
];

// Writes our copies and returns the CDN-to-local mapping the pages need.
export function buildFormChunks({ root, distAssets }) {
  const map = {};
  for (const chunk of FORM_CHUNKS) {
    const from = path.join(root, 'vendor', 'framer', chunk.file);
    if (!fs.existsSync(from)) throw new Error(`framer forms: ${chunk.file} is not vendored`);
    let src = fs.readFileSync(from, 'utf8');

    let imports = 0;
    src = src.replace(/from"\.\/([^"]+)"/g, (_, file) => {
      imports++;
      return `from"${FRAMER_SITE_CDN}${file}"`;
    });
    if (imports !== chunk.siblings) {
      throw new Error(`framer forms: ${chunk.file} expected ${chunk.siblings} sibling imports, found ${imports} — re-vendor it`);
    }
    if (src.includes('import("./') || src.includes('import(`./')) {
      throw new Error(`framer forms: ${chunk.file} gained a relative dynamic import — re-vendor it`);
    }

    const url = `https://api.framer.com/forms/v1/forms/${chunk.formId}/submit`;
    const hits = src.split(url).length - 1;
    if (hits !== 1) {
      throw new Error(`framer forms: ${chunk.file} expected the form url once, found ${hits} — re-vendor it`);
    }
    src = src.split(url).join(INERT_ACTION);

    const out = path.join(distAssets, 'framer', path.basename(chunk.local));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, src);
    map[FRAMER_SITE_CDN + chunk.file] = chunk.local;
  }
  return map;
}

// Points a page at our copies. Rewrites the preload so we do not fetch a copy we never import,
// then adds the mapping to the page's import map, creating it if there is not one yet. A document
// may only have one import map, so the homepage's team-wheel entry is merged rather than replaced.
export function applyFormChunkMap(html, map) {
  const entries = {};
  for (const [cdn, local] of Object.entries(map)) {
    if (!html.includes(cdn)) continue;
    html = html.split(cdn).join(local);
    entries[cdn] = local;
  }
  if (!Object.keys(entries).length) return html;

  const open = html.indexOf('<script type="importmap">');
  if (open >= 0) {
    const start = open + '<script type="importmap">'.length;
    const end = html.indexOf('</script>', start);
    const existing = JSON.parse(html.slice(start, end));
    existing.imports = { ...existing.imports, ...entries };
    return html.slice(0, start) + JSON.stringify(existing) + html.slice(end);
  }
  // An import map has to come before the first module is preloaded or run. The exports do not
  // all lay their heads out the same way, so take the earliest of the two markers and fall back
  // to the end of <head>, which still precedes anything in the body.
  const marks = [
    html.indexOf('<link rel="modulepreload"'),
    html.indexOf('<script type="module"'),
    html.indexOf('</head>'),
  ].filter((i) => i >= 0);
  if (!marks.length) throw new Error('framer forms: nowhere to place the import map');
  const at = Math.min(...marks);
  const tag = `<script type="importmap">${JSON.stringify({ imports: entries })}</script>`;
  return html.slice(0, at) + tag + html.slice(at);
}
