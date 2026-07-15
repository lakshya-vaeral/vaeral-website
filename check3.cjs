const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);
$('.framer-1tpw1b9').each((i, el) => console.log($.html(el)));
