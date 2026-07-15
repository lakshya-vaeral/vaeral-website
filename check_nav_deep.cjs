const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

// Look at NAV 0 (web variant) structure in detail
const webNav = $('nav').eq(0);

// Find the About link and its parent structure
webNav.find('a').each((i, el) => {
  const text = $(el).text().trim();
  if (text === 'About' || text === 'Portfolio' || text === 'Contact') {
    // Show the link and its parent chain up to 3 levels
    let current = $(el);
    let depth = 0;
    let chain = [];
    while (current.length && depth < 5) {
      chain.push({
        tag: current[0].name,
        class: $(current).attr('class') || '',
        dataFramerName: $(current).attr('data-framer-name') || ''
      });
      current = current.parent();
      depth++;
    }
    console.log(`\n=== ${text} ===`);
    console.log('Chain:', JSON.stringify(chain, null, 2));
    console.log('OuterHTML:', $.html(el).substring(0, 500));
  }
});

// Also find the flex container that holds these links
console.log('\n\n=== NAV 0 direct children ===');
webNav.children().each((i, el) => {
  console.log(i, $(el)[0].name, $(el).attr('class')?.substring(0, 60), $(el).attr('data-framer-name'));
});

// Find the container that holds About, Portfolio, Contact
const aboutLink = webNav.find('a').filter((i, el) => $(el).text().trim() === 'About');
if (aboutLink.length) {
  let p = aboutLink.parent();
  for (let i = 0; i < 5; i++) {
    console.log(`\nParent level ${i}: tag=${p[0]?.name}, class=${p.attr('class')?.substring(0, 80)}, data-framer-name=${p.attr('data-framer-name')}`);
    // Show siblings at this level
    console.log(`  Children count: ${p.children().length}`);
    p.children().each((j, child) => {
      console.log(`  Child ${j}: tag=${child.name}, class=${$(child).attr('class')?.substring(0, 60) || ''}, text=${$(child).text().trim().substring(0, 30)}`);
    });
    p = p.parent();
  }
}
