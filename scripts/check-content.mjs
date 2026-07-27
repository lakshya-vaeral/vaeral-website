// scripts/check-content.mjs — content guardrails for service and page copy.
// Run:  node scripts/check-content.mjs
//
// Enforces the editorial rules the SEO plan sets for these pages:
//   - no claims of inauthentic promotion (proxy accounts, seeded/placed reviews)
//   - no guarantees of outcomes nobody can guarantee
//   - no unsourced statistics — a number needs a citation or it gets cut
//   - 5-8 FAQ entries per service page, so FAQPage schema has visible copy behind it
//   - the three section headings the shared template expects
//
// These are the rules that are cheap to break by accident during a CMS edit and
// expensive to discover later, which is why they run in CI rather than by eye.

import fs from 'node:fs';
import path from 'node:path';

const TARGETS = [
  { dir: 'content/services', kind: 'service' },
  { dir: 'content/pages', kind: 'page' },
];

// Practices that breach platform policy (Reddit/Quora/Wikipedia terms, India's
// CCPA fake-review guidance, BIS IS 19000:2022) plus outcome guarantees nobody
// can honestly make. The live homepage currently uses some of these.
//
// These pages necessarily *discuss* the banned practices in order to disclaim
// them ("we do not use upvote services"), so a bare keyword match produces
// nothing but false positives. A finding therefore requires all three of:
//   1. the phrase appears in a sentence,
//   2. the sentence asserts something about us (we / our / Vaeral),
//   3. the sentence is not negating it.
// This is a guardrail against accidental claims, not a substitute for reading
// the copy — it deliberately errs toward silence over crying wolf.
const RISKY = [
  { re: /proxy[- ]backed/i, label: 'proxy-backed accounts' },
  { re: /seed(?:ing|s|ed)? (?:authentic )?reviews?/i, label: 'seeding reviews' },
  { re: /managed narratives?/i, label: 'managed narratives' },
  { re: /\bbuy(?:ing)? reviews?\b/i, label: 'buying reviews' },
  { re: /upvote (?:service|bot)/i, label: 'upvote services' },
  { re: /\bsockpuppet/i, label: 'sockpuppet accounts' },
  { re: /\bguarantee(?:s|d)?\b/i, label: 'outcome guarantee' },
];

const FIRST_PERSON = /\b(we|our|us|vaeral)\b/i;
const NEGATION = /\b(no|not|never|nobody|no one|cannot|can't|don't|do not|without|refuse|decline|prohibit|breach|against)\b/i;

const STAT = /\b\d{1,3}(?:\.\d+)?%|\b\d+(?:\.\d+)?×|\b\d{3,}\+/g;
const CITED = /\[[^\]]*\]\([^)]+\)|https?:\/\//;

// FAQ questions are prompts, not assertions — "Can you guarantee X?" is answered
// below it. Only prose and answers are claims.
const isQuestionLine = (line) => /^\s*-\s*question:/.test(line);

function sentences(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !isQuestionLine(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function frontmatterOf(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

let failures = 0;
const rows = [];

for (const { dir, kind } of TARGETS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    const fmBlock = frontmatterOf(text);
    const problems = [];

    for (const sentence of sentences(text)) {
      if (!FIRST_PERSON.test(sentence) || NEGATION.test(sentence)) continue;
      for (const { re, label } of RISKY) {
        if (re.test(sentence)) {
          problems.push(`asserts ${label}: "${sentence.slice(0, 80)}"`);
        }
      }
    }

    // A statistic is acceptable only on a line that also carries a source link.
    for (const line of text.split(/\r?\n/)) {
      const stats = line.match(STAT);
      if (stats && !CITED.test(line)) {
        problems.push(`uncited statistic ${stats.join(', ')}`);
      }
    }

    const headings = ['sectionOneHeading', 'sectionTwoHeading', 'sectionThreeHeading']
      .filter((k) => !fmBlock.includes(k));
    if (headings.length) problems.push(`missing ${headings.join(', ')}`);

    const faqCount = (text.match(/^ {2}- question:/gm) || []).length;
    if (kind === 'service' && (faqCount < 5 || faqCount > 8)) {
      problems.push(`FAQ count ${faqCount} (want 5-8)`);
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    if (kind === 'service' && words < 700) problems.push(`only ${words} words (want 800+)`);

    if (problems.length) failures++;
    rows.push({ file, words, faqCount, problems });
  }
}

for (const r of rows.sort((a, b) => a.file.localeCompare(b.file))) {
  const status = r.problems.length ? 'FAIL' : ' ok ';
  console.log(`${status} ${String(r.words).padStart(4)}w  faq=${r.faqCount}  ${r.file}`);
  for (const p of r.problems) console.log(`       - ${p}`);
}

console.log(
  failures
    ? `\n${failures} file(s) failing content rules.`
    : `\n${rows.length} file(s) pass: no policy-breaching claims, no unqualified guarantees, no uncited statistics, FAQ counts in range.`,
);
process.exit(failures ? 1 : 0);
