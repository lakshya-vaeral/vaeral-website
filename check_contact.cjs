const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

// Check how many Contact links exist per nav and their parent structure
$('nav').each((navIdx, nav) => {
  console.log(`\n=== NAV ${navIdx} ===`);
  $(nav).find('a').filter((i, el) => $(el).text().trim() === 'Contact').each((i, el) => {
    const parentClass = $(el).parent().attr('class') || '';
    const grandparentClass = $(el).parent().parent().attr('class') || '';
    console.log(`  Contact ${i}: parent="${parentClass.substring(0, 50)}", grandparent="${grandparentClass.substring(0, 50)}"`);
  });
});
