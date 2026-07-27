// scripts/index-report.mjs — monthly Search Console report.
//
// Usage:  node scripts/index-report.mjs [--days 30] [--out report.md]
//
// Credentials come from either:
//   GSC_CREDENTIALS         a JSON string (use a CI secret), or
//   --creds <path>          a local JSON file with {client_id, client_secret, refresh_token}
//
// Never commit the credentials file. It holds a live refresh token.
//
// Reports impressions, clicks, average position, top queries and top pages — and
// explicitly checks whether any retired URL has reappeared in Google, which is the
// regression the SEO plan calls out by name.

import fs from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const DAYS = Number(arg('--days', 30));
const OUT = arg('--out', null);
const SITE = 'sc-domain:vaeral.com';

// Any of these appearing in the report means Google has re-surfaced a dead page.
const RETIRED = [/\/author\//, /\/category\//, /\/tag\//, /\/20\d{2}\//, /\/metform-form\//,
  /\/community\//, /\/boult-audio\//, /\/about-us\//, /\/case-studies\//, /\/insights\//,
  /\/sample-page/, /\/colibri-wp/, /\/feed\/?$/, /holiday-memebership/, /test-blog-1/];

function loadCreds() {
  if (process.env.GSC_CREDENTIALS) return JSON.parse(process.env.GSC_CREDENTIALS);
  const p = arg('--creds', null);
  if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  console.error('No credentials. Set GSC_CREDENTIALS (JSON) or pass --creds <path>.');
  console.error('Needs: {"client_id":"...","client_secret":"...","refresh_token":"..."}');
  process.exit(2);
}

async function accessToken(c) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.client_id, client_secret: c.client_secret,
      refresh_token: c.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error('token refresh failed: ' + JSON.stringify(j));
  return j.access_token;
}

async function query(token, body) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const j = await res.json();
  if (!res.ok) throw new Error('searchAnalytics failed: ' + JSON.stringify(j));
  return j.rows || [];
}

const iso = (d) => d.toISOString().slice(0, 10);
// GSC data lags ~2 days; asking for today returns nothing.
const end = new Date(Date.now() - 2 * 864e5);
const start = new Date(end.getTime() - DAYS * 864e5);

const creds = loadCreds();
const token = await accessToken(creds);
const range = { startDate: iso(start), endDate: iso(end), rowLimit: 25000 };

const [totals, queries, pages] = await Promise.all([
  query(token, { ...range }),
  query(token, { ...range, dimensions: ['query'] }),
  query(token, { ...range, dimensions: ['page'] }),
]);

const t = totals[0] || { clicks: 0, impressions: 0, position: 0 };

// Query classification.
//
// A plain keyword list is not good enough here: the baseline is dominated by
// misspellings of the brand (vairal, veeral, viraal, wiral, vrual, valeral...),
// and treating those as "non-brand" would make the headline metric meaningless.
// So brand detection is fuzzy — any token within edit distance 2 of "vaeral".
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const isBrandToken = (tok) => tok.length >= 4 && editDistance(tok, 'vaeral') <= 2;
const isBrand = (q) => q.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean).some(isBrandToken);

// What the business actually wants to be found for.
const SERVICE_TERMS = /(orm|reputation|reddit|quora|wikipedia|linkedin|review|agency|marketing|seo|aeo|answer engine|ai search|brand)/i;
const isService = (q) => !isBrand(q) && SERVICE_TERMS.test(q);

const brandQ = queries.filter((r) => isBrand(r.keys[0]));
const serviceQ = queries.filter((r) => isService(r.keys[0]));
// Everything else is unrelated noise the site happens to surface for.
const otherQ = queries.filter((r) => !isBrand(r.keys[0]) && !isService(r.keys[0]));

const resurfaced = pages.filter((r) => RETIRED.some((rx) => rx.test(r.keys[0])));

const L = [];
L.push(`# Search Console report — ${iso(start)} to ${iso(end)}`, '');
L.push(`| Metric | Value |`, `|---|---|`);
L.push(`| Impressions | ${t.impressions} |`);
L.push(`| Clicks | ${t.clicks} |`);
L.push(`| Average position | ${t.position?.toFixed(1) ?? '—'} |`);
L.push(`| Distinct queries | ${queries.length} |`);
L.push(`| &nbsp;&nbsp;— brand name or misspelling | ${brandQ.length} |`);
L.push(`| &nbsp;&nbsp;— **service-related (the number that matters)** | **${serviceQ.length}** |`);
L.push(`| &nbsp;&nbsp;— unrelated noise | ${otherQ.length} |`);
L.push(`| Pages with impressions | ${pages.length} |`, '');

L.push('**Service-related queries is the metric to watch.** At the 2026-07-27 baseline',
  'there was exactly **1** — the site was findable only by people who already knew the',
  'name. Growth here means the new service pages are being found by people who do not.', '');

L.push('## Retired URLs', '');
if (resurfaced.length) {
  L.push('⚠️ **Retired pages appeared in Google this period.** Each should be redirecting.', '');
  L.push('| URL | Impressions |', '|---|---|');
  for (const r of resurfaced) L.push(`| ${r.keys[0]} | ${r.impressions} |`);
  L.push('', '_Note: the redirects went live on 2026-07-27. Impressions from before that',
    'date are expected and will age out of the reporting window. Treat this as a real',
    'regression only if the dates fall after the redirects shipped._');
} else {
  L.push('None of the retired URLs appeared this period. The redirects are holding.');
}
L.push('');

L.push('## Service-related queries', '');
if (serviceQ.length) {
  L.push('| Query | Impressions | Clicks | Position |', '|---|---|---|---|');
  for (const r of serviceQ.sort((a, b) => b.impressions - a.impressions).slice(0, 25)) {
    L.push(`| ${r.keys[0]} | ${r.impressions} | ${r.clicks} | ${r.position.toFixed(1)} |`);
  }
} else {
  L.push('_None this period._');
}
L.push('');

L.push('## Top pages', '');
L.push('| Page | Impressions | Clicks | Position |', '|---|---|---|---|');
for (const r of pages.sort((a, b) => b.impressions - a.impressions).slice(0, 20)) {
  L.push(`| ${r.keys[0].replace('https://www.vaeral.com', '') || '/'} | ${r.impressions} | ${r.clicks} | ${r.position.toFixed(1)} |`);
}

const out = L.join('\n') + '\n';
if (OUT) { fs.writeFileSync(OUT, out); console.log(`Wrote ${OUT}`); } else { console.log(out); }

// Surface a resurfaced retired URL as a failure so a scheduled run flags it.
if (resurfaced.length) {
  console.error(`\n${resurfaced.length} retired URL(s) reappeared in Google.`);
  process.exit(1);
}
