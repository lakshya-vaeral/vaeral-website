const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

// Check how many <a> elements are inside each framer-rltyp6-container
$('.framer-rltyp6-container').each((i, el) => {
  const aCount = $(el).find('a').length;
  console.log(`Container ${i}: ${aCount} <a> tags`);
  $(el).find('a').each((j, a) => {
    console.log(`  <a> ${j}: data-framer-name="${$(a).attr('data-framer-name')}", text="${$(a).text().trim()}"`);
  });
});
