// scripts/google-check.mjs — confirms the credential actually reaches both APIs.
//
// Run this once after setting the credential up, and any time a report starts failing. It prints
// which Search Console properties and which Analytics properties the credential can see, so it
// also saves looking the numeric GA4 property id up by hand.
//
//   node scripts/google-check.mjs

import { accessToken, describeCreds, loadCreds, SCOPES } from './google-auth.mjs';

const get = async (url, token) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
};

const reason = (r) => r.json?.error?.message || r.json?.error_description || `HTTP ${r.status}`;

let creds;
try {
  creds = loadCreds();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
console.log('credential:', JSON.stringify(describeCreds(creds)));

let token;
try {
  token = await accessToken([SCOPES.searchConsole, SCOPES.analytics], creds);
  console.log('token      : obtained\n');
} catch (e) {
  console.error('token      : FAILED —', e.message);
  console.error('\nIf this says invalid_grant on a refresh token, the OAuth consent screen is');
  console.error('probably still in Testing, where refresh tokens last seven days.');
  process.exit(1);
}

const sc = await get('https://searchconsole.googleapis.com/webmasters/v3/sites', token);
if (!sc.ok) {
  console.log('SEARCH CONSOLE: no access —', reason(sc));
  console.log('  Grant it in Search Console > Settings > Users and permissions.');
} else {
  const sites = sc.json.siteEntry || [];
  console.log(`SEARCH CONSOLE: ${sites.length} property(ies)`);
  sites.forEach((s) => console.log(`  ${s.permissionLevel.padEnd(16)} ${s.siteUrl}`));
  if (!sites.some((s) => /vaeral\.com/.test(s.siteUrl))) {
    console.log('  NOTE: nothing for vaeral.com. The credential is not a user on that property.');
  }
}

console.log();
const ga = await get('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', token);
if (!ga.ok) {
  console.log('ANALYTICS: no access —', reason(ga));
  console.log('  Grant Viewer in Analytics > Admin > Property access management.');
  console.log('  Also check the Google Analytics Admin and Data APIs are enabled on the project.');
} else {
  const accounts = ga.json.accountSummaries || [];
  console.log(`ANALYTICS: ${accounts.length} account(s)`);
  for (const a of accounts) {
    console.log(`  ${a.displayName}`);
    for (const p of a.propertySummaries || []) {
      // property is "properties/123456789"; the number is what the Data API wants
      console.log(`    ${p.property.replace('properties/', '').padEnd(12)} ${p.displayName}`);
    }
  }
}
