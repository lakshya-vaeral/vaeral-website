// scripts/health-check.mjs — verify the SEO work is still in place on the LIVE site.
//
// Usage:  node scripts/health-check.mjs [--base https://www.vaeral.com] [--quiet]
// Exits non-zero if any check fails, so CI reports it.
//
// This checks production, not dist/, deliberately. The failure mode this exists to
// catch is a deploy or a re-export silently dropping the build-time patches — the
// SEO head tags, the JSON-LD, the nav rewrite. Those all live in build.js, so a
// build that stops running them produces a green build and a broken site.

import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : process.argv[i + 1];
};
const BASE = (arg('--base', 'https://www.vaeral.com') || '').replace(/\/$/, '');
const QUIET = process.argv.includes('--quiet');
const UA = 'Mozilla/5.0 (compatible; VaeralHealthCheck/1.0)';

const failures = [];
const warnings = [];
let checks = 0;

const fail = (area, msg) => failures.push(`${area}: ${msg}`);
const warn = (area, msg) => warnings.push(`${area}: ${msg}`);
const ok = (label) => { checks++; if (!QUIET) console.log(`  ok    ${label}`); };
const bad = (label, area, msg) => { checks++; console.log(`  FAIL  ${label}`); fail(area, msg); };

async function get(url, { redirect = 'follow' } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect, signal: ac.signal });
    const body = res.status < 400 || redirect === 'manual' ? await res.text() : '';
    return { status: res.status, body, headers: res.headers, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

// --- 1. The three files ------------------------------------------------------

console.log('\nFiles');
const files = [
  ['/sitemap.xml', /^application\/xml|^text\/xml/],
  ['/robots.txt', /^text\/plain/],
  ['/llms.txt', /^text\/plain/],
];
let sitemapUrls = [];
for (const [p, ctype] of files) {
  const r = await get(BASE + p);
  if (r.status !== 200) {
    bad(`${p} reachable`, 'files', `${p} returned ${r.status} (expected 200)`);
    continue;
  }
  if (!ctype.test(r.headers.get('content-type') || '')) {
    bad(`${p} content-type`, 'files', `${p} served as "${r.headers.get('content-type')}"`);
    continue;
  }
  ok(`${p} (200, correct type)`);
  if (p === '/sitemap.xml') sitemapUrls = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

// robots must still point at the sitemap, or nothing gets discovered
const robots = await get(BASE + '/robots.txt');
if (robots.body.includes('Sitemap:')) ok('robots.txt references the sitemap');
else bad('robots.txt references the sitemap', 'files', 'Sitemap: line missing from robots.txt');

// --- 2. Deployed sitemap matches what the build produces ---------------------

console.log('\nSitemap');
const localSitemap = path.resolve('dist/sitemap.xml');
if (fs.existsSync(localSitemap)) {
  const expected = [...fs.readFileSync(localSitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const missing = expected.filter((u) => !sitemapUrls.includes(u));
  const extra = sitemapUrls.filter((u) => !expected.includes(u));
  if (!missing.length && !extra.length) {
    ok(`live sitemap matches the build (${sitemapUrls.length} URLs)`);
  } else {
    // Drift means the deployed site is not the site this repo builds.
    bad('live sitemap matches the build', 'sitemap',
      `${missing.length} URL(s) missing live, ${extra.length} unexpected. Missing: ${missing.slice(0, 5).join(', ') || 'none'}`);
  }
} else {
  warn('sitemap', 'dist/sitemap.xml not present locally — run `npm run build` to enable drift detection');
}

// --- 3. Every sitemap URL actually resolves ----------------------------------

console.log('\nPages');
let pageFails = 0;
for (const url of sitemapUrls) {
  const r = await get(url);
  if (r.status !== 200) { pageFails++; bad(url.replace(BASE, '') || '/', 'pages', `${url} returned ${r.status}`); }
}
if (!pageFails && sitemapUrls.length) ok(`all ${sitemapUrls.length} sitemap URLs return 200`);

// --- 4. Head tags and structured data survived the deploy --------------------

console.log('\nHead tags & structured data');
const sample = ['/', '/about', '/services/reddit-marketing', '/online-pharmacy', '/blog/viral-negative']
  .map((p) => BASE + p);

for (const url of sample) {
  const label = url.replace(BASE, '') || '/';
  const r = await get(url);
  if (r.status !== 200) { bad(label, 'pages', `${url} returned ${r.status}`); continue; }
  const h = r.body;
  const problems = [];

  const title = (h.match(/<title>([^<]*)<\/title>/i) || [, ''])[1];
  if (!title) problems.push('no <title>');
  if (title === 'Vaeral') problems.push('title reverted to bare "Vaeral" — homepage SEO patch did not run');

  const canonical = (h.match(/<link rel="canonical" href="([^"]*)"/i) || [, ''])[1];
  if (!canonical.startsWith('https://www.vaeral.com')) problems.push(`canonical is "${canonical}"`);

  for (const rx of [/<meta property="og:image" content="(\/[^"]*)"/i, /<meta name="twitter:image" content="(\/[^"]*)"/i]) {
    const m = h.match(rx);
    if (m) problems.push(`relative social image: ${m[1]}`);
  }

  const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!blocks.length) problems.push('no JSON-LD');
  for (const b of blocks) {
    try { JSON.parse(b[1]); } catch (e) { problems.push(`invalid JSON-LD (${e.message.slice(0, 40)})`); }
  }

  // Nav anchors are relative in the Framer export and break on every non-home page.
  if (/href="\.\.?\/#(about|casestudies)"/.test(h)) problems.push('relative nav anchors are back');

  if (problems.length) bad(label, 'head', `${label} — ${problems.join('; ')}`);
  else ok(`${label} (title, canonical, JSON-LD, nav)`);
}

// --- 5. Organisation record still anchors the entity -------------------------

console.log('\nCompany record');
const home = await get(BASE + '/');
const orgBlock = [...home.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
  .filter(Boolean)
  .flat()
  .find((n) => n['@type'] === 'ProfessionalService');

if (!orgBlock) {
  bad('organisation record present', 'schema', 'ProfessionalService block missing from the homepage');
} else {
  const expect = {
    name: 'Vaeral', legalName: 'House of Swing', foundingDate: '2022',
    '@id': 'https://www.vaeral.com/#organization',
  };
  const wrong = Object.entries(expect).filter(([k, v]) => orgBlock[k] !== v);
  if (wrong.length) bad('organisation record correct', 'schema', wrong.map(([k, v]) => `${k} is "${orgBlock[k]}", expected "${v}"`).join('; '));
  else ok('organisation record (name, entity, founded, id)');

  if (orgBlock.address?.streetAddress) {
    // Deliberate privacy decision — a street address here would be a regression.
    bad('address is city-level only', 'schema', 'streetAddress has appeared in the public schema');
  } else ok('address is city-level only');
}

// --- 6. Legacy redirects still redirect --------------------------------------

console.log('\nLegacy redirects');
const legacy = ['/author/admin', '/boult-audio', '/community', '/about-us', '/stockgro-2', '/holiday-memebership'];
let redirFails = 0;
for (const p of legacy) {
  const r = await get(BASE + p, { redirect: 'manual' });
  if (r.status < 300 || r.status >= 400) {
    redirFails++;
    bad(`${p} redirects`, 'redirects', `${p} returned ${r.status}, expected a redirect`);
  }
}
if (!redirFails) ok(`all ${legacy.length} sampled legacy URLs still redirect`);

// --- summary -----------------------------------------------------------------

console.log(`\n${'─'.repeat(64)}`);
for (const w of warnings) console.log(`WARN  ${w}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S) across ${checks} checks:\n`);
  for (const f of failures) console.log(`  • ${f}`);
  console.log('\nA failure here usually means a deploy dropped the build-time patches.');
  console.log('Check that `npm run build` ran, then re-run this check.');
  process.exit(1);
}
console.log(`All ${checks} checks passed against ${BASE}.`);
