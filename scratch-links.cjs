const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);
$('a').each((i, el) => {
  const href = $(el).attr('href');
  const text = $(el).text().substring(0, 50);
  if (href && href.toLowerCase().includes('blog')) {
    console.log(`Href: ${href}, Text: ${text}`);
  }
});
