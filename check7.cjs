const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('nav').each((i, el) => console.log('NAV', i, ':\n', $.html(el).substring(0, 1000)));
