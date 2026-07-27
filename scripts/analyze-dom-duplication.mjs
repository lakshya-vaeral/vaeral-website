// scripts/analyze-dom-duplication.mjs — measure repeated visible text in built pages.
// Run after a build:  node scripts/analyze-dom-duplication.mjs [--md]
//
// Why this matters: Framer renders desktop/tablet/mobile variants of the same
// component into one DOM and hides all but one with CSS. Browsers and Google cope.
// Many LLM crawlers strip CSS and read raw DOM text, so they see each heading and
// testimonial two or three times over, which dilutes extraction confidence.
//
// This measures what a CSS-blind reader sees. It does NOT measure what a user sees.

import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const asMarkdown = process.argv.includes('--md');

function htmlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name === 'index.html') out.push(p);
  }
  return out;
}

// Strip everything a CSS-blind text extractor would drop, then split into the
// visible text blocks that remain.
function textBlocks(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  return stripped
    .split(/<\/?(?:div|p|h[1-6]|li|section|article|header|footer|nav|td|blockquote)[^>]*>/i)
    .map((chunk) =>
      chunk
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    // Ignore fragments too short to be meaningful content.
    .filter((t) => t.split(' ').length >= 4);
}

const rows = [];

for (const file of htmlFiles(DIST).sort()) {
  if (file.split(path.sep).includes('admin')) continue;

  const html = fs.readFileSync(file, 'utf8');
  const blocks = textBlocks(html);

  const counts = new Map();
  for (const b of blocks) counts.set(b, (counts.get(b) || 0) + 1);

  const totalWords = blocks.reduce((n, b) => n + b.split(' ').length, 0);
  const uniqueWords = [...counts.keys()].reduce((n, b) => n + b.split(' ').length, 0);
  const ratio = uniqueWords ? totalWords / uniqueWords : 0;

  const worst = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 3);

  rows.push({
    url: '/' + path.relative(DIST, file).replace(/\\/g, '/').replace(/index\.html$/, ''),
    blocks: blocks.length,
    uniqueBlocks: counts.size,
    totalWords,
    uniqueWords,
    ratio,
    worst,
  });
}

rows.sort((a, b) => b.ratio - a.ratio);

const flag = (r) => (r.ratio >= 1.5 ? 'HIGH' : r.ratio >= 1.2 ? 'some' : 'ok');

if (asMarkdown) {
  console.log('| Page | Words (all) | Words (unique) | Ratio | Verdict |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| \`${r.url}\` | ${r.totalWords} | ${r.uniqueWords} | **${r.ratio.toFixed(2)}×** | ${flag(r)} |`,
    );
  }
  console.log('\n### Most-repeated blocks\n');
  for (const r of rows.filter((x) => x.ratio >= 1.2).slice(0, 4)) {
    console.log(`**\`${r.url}\`**\n`);
    for (const [text, n] of r.worst) {
      console.log(`- ${n}× — "${text.slice(0, 110)}${text.length > 110 ? '…' : ''}"`);
    }
    console.log('');
  }
} else {
  console.log(`${'PAGE'.padEnd(40)} ${'ALL'.padStart(6)} ${'UNIQ'.padStart(6)} ${'RATIO'.padStart(7)}  VERDICT`);
  for (const r of rows) {
    console.log(
      `${r.url.padEnd(40)} ${String(r.totalWords).padStart(6)} ${String(r.uniqueWords).padStart(6)} ${(r.ratio.toFixed(2) + '×').padStart(7)}  ${flag(r)}`,
    );
  }
  const high = rows.filter((r) => r.ratio >= 1.5);
  console.log(`\n${high.length}/${rows.length} page(s) above the 1.5x threshold.`);
  if (high.length) {
    console.log('\nWorst repeated blocks on the highest-ratio page:');
    for (const [text, n] of high[0].worst) {
      console.log(`  ${n}x  "${text.slice(0, 90)}${text.length > 90 ? '...' : ''}"`);
    }
  }
}
