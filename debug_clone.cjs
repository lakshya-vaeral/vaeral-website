const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $idx = cheerio.load(html, { decodeEntities: false });

$idx('nav').each((navIdx, nav) => {
  const contactLinks = $idx(nav).find('a').filter((i, el) => {
    const text = $idx(el).text().trim();
    const parentClass = $idx(el).parent().attr('class') || '';
    return text === 'Contact' && parentClass.includes('-container');
  });

  console.log(`NAV ${navIdx}: found ${contactLinks.length} Contact link(s)`);

  contactLinks.each((i, contactEl) => {
    const contactLink = $idx(contactEl);
    const container = contactLink.parent();
    const flexRow = container.parent();
    const flexRowText = flexRow.text();
    
    console.log(`  Contact ${i}: container="${(container.attr('class') || '').substring(0, 40)}", flexRow="${(flexRow.attr('class') || '').substring(0, 60)}"`);
    console.log(`  flexRow has About? ${flexRowText.includes('About')}, Portfolio? ${flexRowText.includes('Portfolio')}`);
    console.log(`  existing .nav-blogs-link count: ${flexRow.find('.nav-blogs-link').length}`);
  });
});
