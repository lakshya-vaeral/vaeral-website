const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

// Check the intermediate structure: each framer-8gg6gi-container should contain
// exactly one framer-1tnpw2r flex row. But maybe there are variants inside?
$('nav').eq(0).find('.framer-8gg6gi-container').each((i, el) => {
  console.log(`\n=== framer-8gg6gi-container ${i} ===`);
  $(el).children().each((j, child) => {
    const cls = $(child).attr('class') || '';
    const name = $(child).attr('data-framer-name') || '';
    console.log(`  Child ${j}: tag=${child.name}, class="${cls.substring(0, 80)}", name="${name}"`);
    // Show its children
    $(child).children().each((k, grandchild) => {
      console.log(`    Grandchild ${k}: tag=${grandchild.name}, class="${($(grandchild).attr('class') || '').substring(0, 60)}", text="${$(grandchild).text().trim().substring(0, 30)}"`);
    });
  });
});
