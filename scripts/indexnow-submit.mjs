// scripts/indexnow-submit.mjs — notify IndexNow-participating search engines of
// new or changed URLs. Run after a deploy:  node scripts/indexnow-submit.mjs
//
// Reads dist/sitemap.xml, so it always submits exactly what the site publishes.
// Pass URLs as arguments to submit a subset instead.
//
// Covers Bing, Yandex, Seznam and Naver. NOT Google — Google does not participate
// in IndexNow, and its Indexing API is restricted to JobPosting/BroadcastEvent, so
// Google URLs must still be submitted by hand via Search Console URL Inspection.

import fs from 'node:fs';

const KEY = '578535072428959e7ab91a2f84141b9b';
const HOST = 'www.vaeral.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function urlsFromSitemap() {
  const xml = fs.readFileSync('dist/sitemap.xml', 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : urlsFromSitemap();

if (!urls.length) {
  console.error('No URLs to submit.');
  process.exit(1);
}

const offHost = urls.filter((u) => !u.startsWith(`https://${HOST}/`));
if (offHost.length) {
  // IndexNow rejects the whole batch if any URL is off-host, so fail clearly here
  // rather than getting an opaque 422 back.
  console.error(`Refusing to submit: ${offHost.length} URL(s) not on ${HOST}:`);
  offHost.forEach((u) => console.error(`  ${u}`));
  process.exit(1);
}

console.log(`Submitting ${urls.length} URL(s) for ${HOST}...`);

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: `https://${HOST}/${KEY}.txt`,
    urlList: urls,
  }),
});

const body = await res.text();

// 200 = accepted, 202 = accepted but key still being validated. Both are fine.
if (res.status === 200 || res.status === 202) {
  console.log(`OK (HTTP ${res.status}) — ${urls.length} URL(s) accepted.`);
  urls.forEach((u) => console.log(`  ${u}`));
  console.log('\nAcceptance means the URLs were queued, not that they are indexed.');
  process.exit(0);
}

console.error(`FAILED: HTTP ${res.status}`);
console.error(body || '(empty response body)');
if (res.status === 403) {
  console.error(`\n403 means the key file could not be verified. Check https://${HOST}/${KEY}.txt is live and contains exactly the key.`);
}
process.exit(1);
