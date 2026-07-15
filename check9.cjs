const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('nav a').each((i, el) => {
  if ($(el).text().trim() === 'Contact') {
    console.log('CONTACT HTML:', $.html(el));
  }
});
