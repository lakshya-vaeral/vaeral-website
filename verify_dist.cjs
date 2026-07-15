const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

$('nav').each((i, nav) => {
  console.log(`\n=== NAV ${i} ===`);
  $(nav).find('a').each((j, el) => {
    const text = $(el).text().trim();
    if (text) console.log(`  Link ${j}: "${text}" -> ${$(el).attr('href')}`);
  });
});
