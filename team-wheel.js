// Homepage team wheel ("The People Who Make it Happen") with six more members.
//
// The wheel is a Framer code component: React renders it on the client from data inside the
// page's compiled module on Framer's CDN, so adding members to the exported HTML does nothing —
// hydration rebuilds the wheel from that module and the extra markup is dropped. The data is a
// plain `people:[…]` array in that one module, so the smallest working change is to serve our own
// copy of just that module and let the page load it in place of the CDN one, via an import map.
//
// The copy is built from a pristine vendored chunk at build time: its sibling imports are made
// absolute (they still come from the CDN), the ten photos point at our own files, and the extra
// members are appended to both arrays (the desktop wheel and the phone carousel each hold one).
// Every count is asserted so a re-published Framer bundle fails the build instead of silently
// serving a stale wheel. Fail-safe by construction: if index.html ever stops referencing this
// exact chunk hash the import map matches nothing and the page shows Framer's own wheel.

import fs from 'node:fs';
import path from 'node:path';

const FRAMER_SITE_CDN = 'https://framerusercontent.com/sites/5p7kq1Z1Vb5AjJ64xQUs96/';
const TEAM_CHUNK = 'hjgLgmMb-efQTkJ3DDF3pVhD3P9bwbE6193zSs1Qa68.n2FM1_kX.mjs';
const TEAM_CHUNK_LOCAL = '/assets/framer/team-wheel.mjs';
const SIBLING_IMPORTS = 14;

// the ten members already in the export, keyed by the photo id the chunk uses
const TEAM_PHOTOS = {
  '9mxVm7EEnhbyzUtyjHIuelxZXXQ': 'mayank-sureka.webp',
  'gYrdXz2NjSZVJEyauzpLcDsqo': 'sayan-chakroborty.webp',
  '9cS4HoztG3h3cXlGBLbhksJEMTY': 'jyotisikha-kalita.webp',
  'e81RBzIDptRWFgcj20yZvZaZM': 'tanisha-khemka.webp',
  'MZ6zJXZJyDJZo2ZUQKGPfRRWFJA': 'twinkle-jain.webp',
  '8rKNBQrmFEXAOtcwMcevNhDtCM': 'anusikh-goswami.webp',
  'Hcx28CJr3vadZbn73SrqDQILsp4': 'zayd-hassan.webp',
  'o44h2ODQFHDf27ltbaHcB3frE': 'gajanand-baheti.webp',
  'z1aaBZXfF7N1EiRPquT61w96zx8': 'rajat-saha.webp',
  'Cz12KfKQ9D0L88sUUexAVYf08': 'rohit-bhattacharya.webp',
};

// The six new members. Placeholders until the real people are known: edit the entry, drop the
// photo in public/assets/team/, rebuild. Same shape as the component's own data.
export const TEAM_EXTRA = [1, 2, 3, 4, 5, 6].map((n) => ({
  name: `Team Member ${n}`,
  role: 'Team Member',
  bio: 'Bio coming soon.',
  photo: 'placeholder.png',
}));

// Index just past the ']' closing the array that opens at `open`, skipping template strings —
// the bios contain commas and brackets.
function endOfArray(src, open) {
  let depth = 0;
  let inTemplate = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inTemplate) {
      if (c === '\\') i++;
      else if (c === '`') inTemplate = false;
    } else if (c === '`') inTemplate = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i + 1;
  }
  throw new Error('team wheel: unterminated people array');
}

const memberLiteral = (m) =>
  `{bio:\`${m.bio}\`,name:\`${m.name}\`,profile:ip({pixelHeight:303,pixelWidth:303,src:\`/assets/team/${m.photo}\`},\`\`),role:\`${m.role}\`}`;

// Writes dist/assets/framer/team-wheel.mjs from the vendored chunk. Returns the member count.
export function buildTeamWheelChunk({ root, distAssets }) {
  let src = fs.readFileSync(path.join(root, 'vendor', 'framer', TEAM_CHUNK), 'utf8');

  // sibling modules keep coming from the CDN; relative imports would resolve to our host
  let imports = 0;
  src = src.replace(/from"\.\/([^"]+)"/g, (_, file) => {
    imports++;
    return `from"${FRAMER_SITE_CDN}${file}"`;
  });
  if (imports !== SIBLING_IMPORTS) {
    throw new Error(`team wheel: expected ${SIBLING_IMPORTS} sibling imports, found ${imports} — chunk changed`);
  }
  if (src.includes('import("./') || src.includes('import(`./')) {
    throw new Error('team wheel: chunk gained a relative dynamic import — chunk changed');
  }

  // the ten photos become ours; each appears once per array, so twice
  for (const [id, file] of Object.entries(TEAM_PHOTOS)) {
    const cdn = `https://framerusercontent.com/images/${id}.png?width=303&height=303`;
    const n = src.split(cdn).length - 1;
    if (n !== 2) throw new Error(`team wheel: photo ${id} expected twice, found ${n}`);
    src = src.split(cdn).join(`/assets/team/${file}`);
  }

  // append the extra members to every people:[...] array that holds the real team
  const extra = TEAM_EXTRA.map(memberLiteral).join(',');
  const opens = [];
  for (let i = src.indexOf('people:['); i >= 0; i = src.indexOf('people:[', i + 1)) {
    if (src.slice(i, i + 2000).includes('name:`Mayank Sureka`')) opens.push(i + 'people:'.length);
  }
  if (opens.length !== 2) throw new Error(`team wheel: expected 2 team arrays, found ${opens.length}`);
  const existing = Object.keys(TEAM_PHOTOS).length;
  for (const open of opens.reverse()) {
    const end = endOfArray(src, open);
    const have = src.slice(open, end).split('name:`').length - 1;
    if (have !== existing) throw new Error(`team wheel: expected ${existing} members in an array, found ${have}`);
    src = src.slice(0, end - 1) + ',' + extra + src.slice(end - 1);
  }

  const out = path.join(distAssets, 'framer', 'team-wheel.mjs');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, src);
  return existing + TEAM_EXTRA.length;
}

// The homepage loads our chunk instead of the CDN one. An import map must precede the first
// module preload or module script, so it goes in front of the first <link rel="modulepreload">.
export function patchHomepageTeam(html) {
  if (html.includes('type="importmap"')) throw new Error('homepage team: import map already present');
  const cdnChunk = FRAMER_SITE_CDN + TEAM_CHUNK;
  const refs = html.split(cdnChunk).length - 1;
  if (refs !== 1) {
    throw new Error(`homepage team: expected the export to preload ${TEAM_CHUNK} once, found ${refs} — re-vendor the chunk`);
  }
  html = html.replace(cdnChunk, TEAM_CHUNK_LOCAL); // do not preload a copy we never import
  const firstPreload = html.indexOf('<link rel="modulepreload"');
  const firstModule = html.indexOf('type="module"');
  if (firstPreload < 0 || firstModule < firstPreload) throw new Error('homepage team: head layout changed');
  const importMap = `<script type="importmap">${JSON.stringify({ imports: { [cdnChunk]: TEAM_CHUNK_LOCAL } })}</script>`;
  return html.slice(0, firstPreload) + importMap + html.slice(firstPreload);
}
