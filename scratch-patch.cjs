const fs = require('fs');
let html = fs.readFileSync('dist/index.html', 'utf8');
html = html.replace(/href="\.\/blog/g, 'target="_top" href="/blog');
const cheerio = require('cheerio');
const $ = cheerio.load(html);
$('a').each((i, el) => {
  const href = $(el).attr('href');
  if (href && href.toLowerCase().includes('blog')) {
    console.log(`Href: ${href}, Target: ${$(el).attr('target')}`);
  }
});
