const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('nav a').each((i, el) => console.log('LINK:', $(el).text(), '| STYLE:', $(el).attr('style')));
