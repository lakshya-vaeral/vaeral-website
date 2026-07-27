// scripts/validate-schema.mjs — structural validation of every JSON-LD block in dist/.
// Run after a build:  node scripts/validate-schema.mjs
//
// This checks what can be checked offline: that each block is parseable JSON, has
// the required properties for its @type, that @id references resolve to a node
// that actually exists, and that no URL still points at the apex host. It does
// NOT replace Google's Rich Results Test — run the surviving URLs through that
// too before trusting the output.

import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const CANONICAL_HOST = 'https://www.vaeral.com';

const REQUIRED = {
  ProfessionalService: ['@id', 'name', 'url', 'description'],
  BlogPosting: ['@id', 'headline', 'datePublished', 'author', 'publisher', 'mainEntityOfPage'],
  Article: ['@id', 'headline', 'datePublished', 'author', 'publisher', 'mainEntityOfPage'],
  BreadcrumbList: ['itemListElement'],
};

function htmlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const BLOCK_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

const declaredIds = new Set();
const referencedIds = [];
const pages = [];
let errors = 0;

for (const file of htmlFiles(DIST).sort()) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(BLOCK_RE)].map((m) => m[1]);
  const types = [];

  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.log(`FAIL ${file}: unparseable JSON-LD — ${err.message}`);
      errors++;
      continue;
    }

    for (const node of [].concat(parsed)) {
      const type = node['@type'] || '(untyped)';
      types.push(type);

      if (node['@id']) declaredIds.add(node['@id']);
      for (const key of ['author', 'publisher']) {
        if (node[key] && node[key]['@id']) referencedIds.push({ file, ref: node[key]['@id'] });
      }

      for (const prop of REQUIRED[type] || []) {
        if (node[prop] === undefined) {
          console.log(`FAIL ${file}: ${type} missing required property "${prop}"`);
          errors++;
        }
      }

      const apex = JSON.stringify(node).match(/https:\/\/vaeral\.com/g);
      if (apex) {
        console.log(`FAIL ${file}: ${type} contains ${apex.length} apex URL(s); expected ${CANONICAL_HOST}`);
        errors++;
      }
    }
  }

  // The CMS admin UI is noindex and intentionally carries no structured data.
  const exempt = file.split(path.sep).includes('admin');
  pages.push({ file, count: blocks.length, types, exempt });
  if (!blocks.length && !exempt) {
    console.log(`WARN ${file}: no JSON-LD block`);
  }
}

for (const { file, ref } of referencedIds) {
  if (!declaredIds.has(ref)) {
    console.log(`FAIL ${file}: @id reference "${ref}" does not resolve to any declared node`);
    errors++;
  }
}

console.log(`\n${'PAGE'.padEnd(52)} BLOCKS  TYPES`);
for (const p of pages) {
  const label = p.exempt ? '(exempt: noindex admin UI)' : p.types.join(', ') || '-';
  console.log(`${p.file.padEnd(52)} ${String(p.count).padStart(6)}  ${label}`);
}

const indexable = pages.filter((p) => !p.exempt);
const withLd = indexable.filter((p) => p.count > 0).length;
console.log(`\n${withLd}/${indexable.length} indexable pages carry structured data; ${declaredIds.size} unique @id nodes declared.`);
console.log(errors ? `\n${errors} error(s).` : '\nAll JSON-LD valid: parses, required properties present, @id references resolve, canonical host only.');
process.exit(errors ? 1 : 0);
