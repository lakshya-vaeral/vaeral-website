const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

// Check the exact structure of the Blogs links in the dist output
$('nav').eq(0).find('.framer-8gg6gi-container').each((i, el) => {
  console.log(`\n=== framer-8gg6gi-container ${i} ===`);
  $(el).children().each((j, child) => {
    console.log(`  Child ${j}: class="${($(child).attr('class') || '').substring(0, 80)}", name="${$(child).attr('data-framer-name') || ''}"`);
    $(child).children().each((k, grandchild) => {
      console.log(`    GC ${k}: class="${($(grandchild).attr('class') || '').substring(0, 60)}", text="${$(grandchild).text().trim().substring(0, 30)}"`);
    });
  });
});
