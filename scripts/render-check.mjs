#!/usr/bin/env node
/**
 * Verifies pages as a BROWSER renders them, not as curl fetches them.
 *
 * Why this exists: for weeks, 13 pages served the correct HTML and rendered the wrong case
 * study. Framer's runtime replaced the injected content after hydration. Every check we had
 * — validate-schema, check-content, health-check — fetches raw HTML, so all of them passed
 * while real visitors and Googlebot (which executes JS) saw a different page. A markdown
 * table shipped invisible for the same reason: the HTML was right, the rendering was not.
 *
 * Two assertions, both requiring a real browser:
 *   1. HYDRATION — the <h1> after hydration matches the <h1> in the served HTML. Catches the
 *      runtime replacing injected content.
 *   2. LEGIBILITY — no text-bearing element inside a CMS content container renders at a
 *      colour too close to its own background. Catches the invisible-table class of bug for
 *      any element, including ones nobody has thought of yet.
 *
 * Usage:
 *   node scripts/render-check.mjs                 # against ./dist via a local server
 *   node scripts/render-check.mjs --live          # against https://www.vaeral.com
 *   node scripts/render-check.mjs --base=<url>    # against a Vercel preview
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIST = 'dist';
const PROD = 'https://www.vaeral.com';
const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith('--base='));
const LIVE = args.includes('--live');
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || '';

// Chrome locations, in the order we try them.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    console.error('render-check: no Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.');
    console.error('Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
    process.exit(2);
  }
  return hit;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff2': 'font/woff2',
};

/**
 * Serves the pages under test with the measurement script injected into the page itself.
 *
 * An iframe was the obvious approach and does not work: the harness page has to come from
 * somewhere, and a data: URL has an opaque origin, so contentDocument access is blocked. The
 * measurement needs getComputedStyle on the target's own elements, which means it has to run
 * inside the target document. So we inject rather than embed.
 *
 * In remote mode we proxy the page and add <base href> so its assets and Framer's runtime
 * still load from the real origin — hydration behaves as it does in production, which is the
 * whole point of checking there.
 */
async function serve({ remote }) {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    try {
      if (remote) {
        const target = `${remote}${rel}`;
        const r = await fetch(target, { headers: { 'user-agent': 'render-check' }, redirect: 'follow' });
        const html = await r.text();
        res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(injectProbe(html, `${remote}/`));
        return;
      }
      let file = path.join(DIST, rel.endsWith('/') ? rel + 'index.html' : rel);
      const buf = await readFile(file);
      if (file.endsWith('.html')) {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(injectProbe(buf.toString('utf8'), null));
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Measurement script, injected at the end of the target document.
 *
 * It runs after load plus a delay so any client-side runtime has finished replacing the DOM —
 * measuring before that would report the served content and miss the exact bug this checks
 * for. Results go into a <pre> that --dump-dom returns.
 *
 * Legibility uses the WCAG contrast formula against the element's own effective background,
 * found by walking up to the first non-transparent ancestor, so it stays correct if the
 * palette changes. The threshold is deliberately low (1.6:1) — this is an
 * is-it-rendered-at-all check, not an accessibility audit, and a low bar keeps it free of
 * false positives on intentionally muted text.
 */
const PROBE_SCRIPT = `
<pre id="__rc" style="display:none">pending</pre>
<script>
(function(){
  function ownText(el){
    var t='';
    for (var i=0;i<el.childNodes.length;i++)
      if (el.childNodes[i].nodeType===3) t+=el.childNodes[i].textContent;
    return t.trim();
  }
  function parse(c){ var m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c); return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:parseFloat(m[4])]:null; }
  function bgOf(el){
    for (var n=el; n && n.nodeType===1; n=n.parentElement){
      var c=parse(getComputedStyle(n).backgroundColor);
      if (c && c[3]>0.5) return [c[0],c[1],c[2]];
    }
    return [0,0,0];
  }
  function chan(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }
  function rel(c){ return 0.2126*chan(c[0])+0.7152*chan(c[1])+0.0722*chan(c[2]); }
  function measure(){
    var out={h1:null,title:null,illegible:[],unreachable:[],error:null};
    try {
      out.__ok = true;
      var h=document.querySelector('h1');
      out.h1=h?h.textContent.replace(/\\s+/g,' ').trim():null;
      out.title=document.title;

      // Content below the document's scroll height cannot be scrolled to — it is painted but
      // unreachable. This is how the footer disappeared: the export hard-coded the page root
      // to a fixed canvas height with overflow:clip, so any page whose content exceeded it had
      // the overflow both clipped and excluded from scrollHeight. Screenshots missed it because
      // a tall window gives a viewport taller than the document, so the clipped part still
      // paints. Only comparing element bottoms against scrollHeight catches it.
      var docH=document.documentElement.scrollHeight;
      var scrollTop=document.scrollingElement?document.scrollingElement.scrollTop:0;
      var seen={};
      document.querySelectorAll('footer, main, section, h1, h2, h3, p, table').forEach(function(el){
        var r=el.getBoundingClientRect();
        if(r.width===0||r.height===0) return;
        if(!(el.textContent||'').trim()) return;
        var bottom=Math.round(r.bottom+scrollTop);
        if(bottom>docH+2){
          var tag=el.tagName.toLowerCase();
          if(seen[tag]) return;                       // one report per tag is enough to fail
          seen[tag]=1;
          out.unreachable.push({tag:tag,bottom:bottom,docHeight:docH,cut:bottom-docH});
        }
      });
      document.querySelectorAll('[data-framer-component-type="RichTextContainer"] *').forEach(function(el){
        var txt=ownText(el);
        if(!txt) return;
        var cs=getComputedStyle(el);
        if(cs.visibility==='hidden'||cs.display==='none'||+cs.opacity===0) return;
        var fg=parse(cs.color);
        if(!fg) return;
        var bg=bgOf(el);
        var L1=rel(fg), L2=rel(bg);
        var ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
        if(ratio<1.6) out.illegible.push({
          tag:el.tagName.toLowerCase(),
          color:cs.color,
          bg:'rgb('+bg.join(',')+')',
          ratio:Math.round(ratio*100)/100,
          text:txt.slice(0,40)
        });
      });
    } catch(e){ out.error=String(e); }
    return out;
  }

  // Two samples, and only findings present in BOTH are reported.
  //
  // The homepage still runs the Framer runtime, and mid-hydration it briefly paints card text
  // unstyled — a single sample at 2.5s reported five case-study titles as black-on-black that are
  // white once rendering settles. Reporting those would have made this check untrustworthy on the
  // one page that most needs it. Static pages are unaffected: their two samples are identical.
  function key(x){ return (x.tag||'') + '|' + (x.text||'') + '|' + (x.bottom||''); }

  function sampleTwice(){
    var first = measure();
    setTimeout(function(){
      var second = measure();
      if (first.error || second.error) {
        document.getElementById('__rc').textContent = JSON.stringify(second.error ? second : first);
        return;
      }
      var firstKeys = {};
      first.illegible.forEach(function(x){ firstKeys[key(x)] = 1; });
      var firstUnreach = {};
      first.unreachable.forEach(function(x){ firstUnreach[key(x)] = 1; });

      second.illegible = second.illegible.filter(function(x){ return firstKeys[key(x)]; });
      second.unreachable = second.unreachable.filter(function(x){ return firstUnreach[key(x)]; });
      document.getElementById('__rc').textContent = JSON.stringify(second);
    }, 2500);
  }

  if (document.readyState === 'complete') setTimeout(sampleTwice, 2500);
  else window.addEventListener('load', function(){ setTimeout(sampleTwice, 2500); });
})();
</script>`;

function injectProbe(html, baseHref) {
  let out = html;
  if (baseHref && !/<base\s/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
  }
  return out.includes('</body>') ? out.replace('</body>', `${PROBE_SCRIPT}</body>`) : out + PROBE_SCRIPT;
}

async function probe(chrome, profile, target) {
  const out = await new Promise((resolve) => {
    const p = spawn(chrome, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${profile}`, '--virtual-time-budget=20000',
      '--window-size=1280,1400', '--dump-dom', target,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', () => resolve(buf));
  });
  const m = /<pre id="__rc"[^>]*>([\s\S]*?)<\/pre>/.exec(out);
  if (!m) return { error: 'measurement script did not run (page may not have loaded)' };
  const decoded = m[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  if (decoded.trim() === 'pending') return { error: 'load event never fired (blocked, 404, or auth wall)' };
  try { return JSON.parse(decoded); } catch { return { error: 'unparseable output: ' + decoded.slice(0, 140) }; }
}

// The <h1> in the served HTML, entities decoded, for comparison against the hydrated one.
function servedH1(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every page the build produces, discovered rather than hardcoded, so new CMS content is
// covered the moment it exists. A hardcoded list is how you get an unchecked new page.
async function discoverRoutes() {
  const routes = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'admin' || entry.name === 'assets' || entry.name.startsWith('_')) continue;
      const sub = path.join(dir, entry.name);
      if (existsSync(path.join(sub, 'index.html'))) routes.push(`${prefix}/${entry.name}`);
      await walk(sub, `${prefix}/${entry.name}`);
    }
  }
  await walk(DIST, '');

  // The homepage lives at dist/index.html, not in a subdirectory, so the walk above skipped it —
  // which is exactly why two homepage regressions (a nav link reverting on hydration, and an
  // injected CTA being dropped by React) had to be found by hand instead of by this check. It is
  // also the page most exposed to that class of bug, since it is the only one that still runs the
  // Framer runtime.
  if (existsSync(path.join(DIST, 'index.html'))) routes.push('');

  return routes.sort();
}

async function main() {
  const chrome = findChrome();
  const remote = baseArg ? baseArg.slice('--base='.length).replace(/\/$/, '') : LIVE ? PROD : null;
  const { server, base } = await serve({ remote });

  const routes = await discoverRoutes();
  const suffix = BYPASS && remote && remote.includes('vercel.app')
    ? `?x-vercel-protection-bypass=${BYPASS}&x-vercel-set-bypass-cookie=true` : '';

  console.log(`render-check: ${routes.length} pages against ${remote || './dist'}`);
  if (suffix) console.log('  (using Vercel protection bypass)');
  console.log('');

  const profile = await mkdtemp(path.join(tmpdir(), 'render-check-'));
  const failures = [];

  try {
    for (const route of routes) {
      const url = `${base}${route}/${suffix}`;
      const result = await probe(chrome, profile, url);

      if (result.error) {
        failures.push(`${route}: ${result.error}`);
        console.log(`  FAIL ${route} — ${result.error}`);
        continue;
      }

      // 1. Hydration: what the browser ends up showing must be what we served.
      const servedHtml = remote
        ? await (await fetch(`${remote}${route}`, { headers: { 'user-agent': 'render-check' } })).text()
        : await readFile(path.join(DIST, route, 'index.html'), 'utf8');
      const expected = servedH1(servedHtml);
      const got = result.h1 ? result.h1.replace(/\s+/g, ' ').trim() : null;

      const problems = [];
      if (expected && got !== expected) {
        problems.push(`hydrated h1 "${(got || 'NONE').slice(0, 46)}" != served h1 "${expected.slice(0, 46)}"`);
      }

      // 2. Legibility: nothing in CMS content may render at near-zero contrast.
      for (const bad of result.illegible || []) {
        problems.push(`<${bad.tag}> contrast ${bad.ratio}:1 (${bad.color} on ${bad.bg}) — "${bad.text}"`);
      }

      // 3. Reachability: nothing may sit below the document's scroll height.
      for (const cut of result.unreachable || []) {
        problems.push(
          `<${cut.tag}> ends at ${cut.bottom}px but the document only scrolls to ${cut.docHeight}px ` +
            `— ${cut.cut}px is unreachable`,
        );
      }

      if (problems.length) {
        failures.push(`${route}: ${problems.join('; ')}`);
        console.log(`  FAIL ${route}`);
        problems.forEach((p) => console.log(`         ${p}`));
      } else {
        console.log(`  ok   ${route}`);
      }
    }
  } finally {
    if (server) server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log('─'.repeat(64));
  if (failures.length) {
    console.log(`render-check FAILED: ${failures.length} of ${routes.length} pages.`);
    console.log('');
    console.log('A hydration mismatch means a client-side runtime is replacing injected content.');
    console.log('A contrast failure means content is in the DOM but unreadable on screen.');
    console.log('An unreachable failure means content exists but cannot be scrolled to.');
    console.log('None of these are visible to curl-based checks — that is the point of this script.');
    process.exit(1);
  }
  console.log(`All ${routes.length} pages render what they serve; content is legible and reachable.`);
}

main().catch((e) => {
  console.error('render-check crashed:', e);
  process.exit(2);
});
