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
//
// The same copy also lets the wheel grow. The component ignores its container — Framer hands it
// width/height as "100%", so its size hook falls back to a fixed 520px box — which left it small
// beside a lot of empty section on wide screens. Our copy measures its root and sizes from that,
// so the container's CSS (HOMEPAGE_FIX_STYLES in build.js) decides how big the wheel is; the
// avatars get a larger share of it and the card type scales with the viewport.

import fs from 'node:fs';
import path from 'node:path';

const FRAMER_SITE_CDN = 'https://framerusercontent.com/sites/5p7kq1Z1Vb5AjJ64xQUs96/';
const TEAM_CHUNK = 'hjgLgmMb-efQTkJ3DDF3pVhD3P9bwbE6193zSs1Qa68.n2FM1_kX.mjs';
const TEAM_CHUNK_LOCAL = '/assets/framer/team-wheel.mjs';
const SIBLING_IMPORTS = 14;

// the orbit component's size hook and the measuring code that goes in front of it; `c`, `_` and
// `pe` are the component's own useState, useEffect and root ref. 600 is the fallback for a
// container CSS leaves content-sized (tablet); on desktop the measured size wins.
const SIZE_HOOK = 'let F=v(()=>{let e=typeof D?.width==`number`?D?.width:void 0,t=typeof D?.height==`number`?D?.height:void 0,n=Math.max(240,Math.min(e??520,t??520));';
const SIZE_HOOK_MEASURED = SIZE_HOOK.replace('Math.min(e??520,t??520)', 'Rz||Math.min(e??600,t??600)');
const SIZE_HOOK_DEPS = '[S,C,w,D?.width,D?.height])';
const MEASURE_ROOT = 'let[Rz,Rs]=c(0);_(()=>{let e=pe.current;if(!e||typeof ResizeObserver>`u`)return;let t=new ResizeObserver(([e])=>{let{width:t,height:n}=e.contentRect;Rs(Math.floor(Math.min(t,n)))});return t.observe(e),()=>t.disconnect()},[]);';

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

// The six new members, in the order the team doc lists them. To change one: edit the entry, drop
// a 303x303 photo in public/assets/team/, rebuild. Same shape as the component's own data.
export const TEAM_EXTRA = [
  {
    name: 'Laksh Batra',
    role: 'Account Manager',
    bio: "Knows every client's brand, brief, and deadline better than the clients themselves. Replies within seconds. We're not sure when/if he sleeps.",
    photo: 'laksh.webp',
  },
  {
    name: 'Vishal Rathod',
    role: 'Account Manager',
    bio: 'Manages five accounts simultaneously without making it sound like a big deal. Sends the most organised emails in the building. His favourite hobby is to take follow-ups.',
    photo: 'vishal.webp',
  },
  {
    name: 'Lakshya Pandey',
    role: 'Digital Infrastructure Specialist',
    bio: "Nobody fully understands his job title, including him. Manages the website, fixes what breaks, helps in SEO improvements. Loves to give AI solutions for problems you don't even have.",
    photo: 'placeholder.png', // no photo supplied yet
  },
  {
    name: 'Sirsha Barui',
    role: 'Community Content Specialist',
    bio: 'Has written so many things on the internet that real strangers have genuinely agreed with, argued about, and bookmarked. Plans to do the same for a long time.',
    photo: 'sirsha.webp',
  },
  {
    name: 'Armin Virk',
    role: 'Content Lead',
    bio: 'Reads brand briefs like most people read novels. The first person to know when something is off and the last person to leave it that way. Has strong feelings about people who use words like "synergy".',
    photo: 'armin.webp',
  },
  {
    name: 'Sandipan Roy',
    role: 'Community Content Specialist',
    bio: 'Understands community tone the way musicians understand music. Not fond of people who get it wrong. Speaks less and feels 90% of meetings are unnecessary.',
    photo: 'sandipan.webp',
  },
];

// Exact-count replacement: the chunk is minified, so a miss means the bundle changed.
function swap(src, from, to, times, what) {
  const n = src.split(from).length - 1;
  if (n !== times) throw new Error(`team wheel: expected ${what} ${times}x, found ${n} — chunk changed`);
  return src.split(from).join(to);
}

// The wheel's size comes from its container, the avatars take .095 of it instead of .085, and the
// card's type scales 13→16px (body) / 17→20px (name) with the viewport, matching the wheel's own
// clamp() in build.js. Touches the orbit component and the one instance Framer places on the
// page; the phone carousel is a different component and keeps its own sizes.
function enlargeOrbit(src) {
  const orbit = src.indexOf('orbitRadiusFactor:S=.33'); // the orbit component's defaults
  const hook = src.indexOf(SIZE_HOOK, orbit);
  if (orbit < 0 || hook < 0) throw new Error('team wheel: orbit size hook not found — chunk changed');
  src = swap(src, SIZE_HOOK, MEASURE_ROOT + SIZE_HOOK_MEASURED, 1, 'size hook');
  src = swap(src, SIZE_HOOK_DEPS, '[S,C,w,D?.width,D?.height,Rz])', 1, 'size hook deps');

  const factor = src.indexOf('orbitRadiusFactor:.39'); // the instance's props
  const start = src.lastIndexOf('children:p(Ud,{', factor);
  const end = src.indexOf('})', factor);
  if (factor < 0 || start < 0 || end < 0) throw new Error('team wheel: orbit instance not found — chunk changed');
  let props = src.slice(start, end);
  props = swap(props, 'profileSizeFactor:.085', 'profileSizeFactor:.095', 1, 'avatar factor');
  props = swap(props, 'cardWidthFactor:.55', 'cardWidthFactor:.5', 1, 'card width factor');
  props = swap(props, 'fontSize:`12px`', 'fontSize:`clamp(13px, 0.95vw, 16px)`', 2, 'body/bio font size');
  props = swap(props, 'fontSize:`16px`', 'fontSize:`clamp(17px, 1.2vw, 20px)`', 1, 'title font size');
  // The name sits in an overflow:hidden box the height of its line-height, and the export sets
  // that to 1.15em while Plus Jakarta Sans needs 1.68em of ink — so every descender (Mayank,
  // Lakshya, Gajanand) was sliced flat. 1.7em fits the glyphs; the export's own clipped-descender
  // fixes in HOMEPAGE_FIX_STYLES do the same thing for the page headings.
  props = swap(props, 'letterSpacing:`-0.02em`,lineHeight:`1.15em`', 'letterSpacing:`-0.02em`,lineHeight:`1.7em`', 1, 'title line height');
  // The taller name line and the smaller wheel together left the card's corners within a pixel
  // of the avatars on the diagonals, so the card gives back the room: 14px of inner padding
  // instead of 19 (the text area gets wider, so the bio wraps into fewer lines).
  props = swap(props, 'cardPadding:19', 'cardPadding:14', 1, 'card padding');
  // The role sits in the same nowrap/ellipsis box as the name, styled by bodyFont, and 1.2em
  // clipped the tails of "Digital Infrastructure Specialist" and friends by a fraction of a
  // pixel — enough to read as flattened. 1.5em leaves room at every size; the text gap comes
  // down from 9 to 6 so the taller line does not grow the card back into the avatars.
  props = swap(props, 'fontWeight:500,letterSpacing:`-0.01em`,lineHeight:`1.2em`', 'fontWeight:500,letterSpacing:`-0.01em`,lineHeight:`1.5em`', 1, 'role line height');
  props = swap(props, 'cardTextGap:9', 'cardTextGap:6', 1, 'card text gap');
  src = src.slice(0, start) + props + src.slice(end);

  // The phone carousel and the export's dead third variant are separate instances of a sibling
  // component carrying the same 1.15em title, so their names clip the same way. Same fix; matched
  // on the weight so the two property-control defaults (which no instance reads) stay untouched.
  for (const weight of [600, 700]) {
    src = swap(src, `fontWeight:${weight},letterSpacing:\`-0.02em\`,lineHeight:\`1.15em\``,
      `fontWeight:${weight},letterSpacing:\`-0.02em\`,lineHeight:\`1.7em\``, 1, `title line height (${weight})`);
  }
  return src;
}

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

  src = enlargeOrbit(src);

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
