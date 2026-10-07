// scripts/analytics-report.mjs — GA4 traffic report, the counterpart to index-report.mjs.
//
//   node scripts/analytics-report.mjs [--days 28] [--property 123456789] [--out report.md]
//
// The property is the NUMERIC id from Analytics > Admin > Property settings, not the G-XXXX
// measurement id the site sends events with. Left out, it is discovered from the credential and
// matched against vaeral; GA4_PROPERTY_ID in the environment also works.
//
// Credentials come from scripts/google-auth.mjs. See that file for where it looks.

import fs from 'node:fs';
import { accessToken, SCOPES } from './google-auth.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const DAYS = Number(arg('--days', 28));
const OUT = arg('--out', null);

const token = await accessToken([SCOPES.analytics]);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function discoverProperty() {
  const res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { headers: auth });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`cannot list properties: ${json.error?.message || res.status}`);
  const all = (json.accountSummaries || []).flatMap((a) => a.propertySummaries || []);
  const hit = all.find((p) => /vaeral/i.test(p.displayName)) || all[0];
  if (!hit) throw new Error('the credential can see no Analytics property; grant it Viewer access');
  return hit.property.replace('properties/', '');
}

const property = arg('--property', process.env.GA4_PROPERTY_ID) || await discoverProperty();

// One report per question. Keeping them separate costs an extra round trip each and makes the
// output far easier to read than one table with every dimension crossed.
async function run(dimensions, metrics, limit = 10) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'today' }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${dimensions.join('+') || 'totals'}: ${json.error?.message || res.status}`);
  return (json.rows || []).map((r) => ({
    keys: (r.dimensionValues || []).map((v) => v.value),
    values: (r.metricValues || []).map((v) => v.value),
  }));
}

const table = (title, headers, rows) => {
  const out = [`### ${title}`, '', `| ${headers.join(' | ')} |`, `|${headers.map(() => ':---:').join('|')}|`];
  if (!rows.length) out.push(`| ${headers.map(() => '—').join(' | ')} |`);
  rows.forEach((r) => out.push(`| ${[...r.keys, ...r.values].join(' | ')} |`));
  return out.concat('').join('\n');
};

const lines = [`## vaeral.com — Analytics, last ${DAYS} days`, '', `Property ${property}.`, ''];

const totals = await run([], ['sessions', 'totalUsers', 'newUsers', 'screenPageViews', 'averageSessionDuration', 'bounceRate'], 1);
if (totals.length) {
  const [s, u, n, v, d, b] = totals[0].values;
  lines.push(table('Totals', ['Sessions', 'Users', 'New users', 'Views', 'Avg session (s)', 'Bounce rate'],
    [{ keys: [], values: [s, u, n, v, Number(d).toFixed(0), `${(Number(b) * 100).toFixed(1)}%`] }]));
}

lines.push(table('Channels', ['Channel', 'Sessions', 'Users'],
  await run(['sessionDefaultChannelGroup'], ['sessions', 'totalUsers'])));
lines.push(table('Top landing pages', ['Page', 'Sessions', 'Bounce rate'],
  (await run(['landingPage'], ['sessions', 'bounceRate'], 15))
    .map((r) => ({ keys: r.keys, values: [r.values[0], `${(Number(r.values[1]) * 100).toFixed(1)}%`] }))));
lines.push(table('Countries', ['Country', 'Sessions'], await run(['country'], ['sessions'])));
lines.push(table('Devices', ['Device', 'Sessions'], await run(['deviceCategory'], ['sessions'])));

const report = lines.join('\n');
if (OUT) { fs.writeFileSync(OUT, report); console.log(`wrote ${OUT}`); } else { console.log(report); }
