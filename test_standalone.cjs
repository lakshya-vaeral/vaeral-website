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

  contactLinks.each((i, contactEl) => {
    const contactLink = $idx(contactEl);
    const container = contactLink.parent();
    const flexRow = container.parent();
    const flexRowText = flexRow.text();
    if (!flexRowText.includes('About') || !flexRowText.includes('Portfolio')) return;
    if (flexRow.find('.nav-blogs-link').length > 0) return;

    const blogContainer = container.clone();
    blogContainer.addClass('nav-blogs-link');
    const blogLink = blogContainer.find('a').first();
    blogLink.attr('href', '/blog');
    blogLink.attr('target', '_top');
    const textSpan = blogLink.find('span').last();
    if (textSpan.length) {
      textSpan.text('Blogs');
    } else {
      blogLink.find('p').last().text('Blogs');
    }
    container.before(blogContainer);
  });
});

// Now count blog links in the output
const output = $idx.html();
const $out = cheerio.load(output);
$out('nav').each((i, nav) => {
  const blogsCount = $out(nav).find('a').filter((j, el) => $out(el).text().trim() === 'Blogs').length;
  const contactCount = $out(nav).find('a').filter((j, el) => $out(el).text().trim() === 'Contact').length;
  console.log(`NAV ${i}: Blogs=${blogsCount}, Contact=${contactCount}`);
});
