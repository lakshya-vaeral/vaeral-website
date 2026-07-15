const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

const button = $('a:contains("View all posts")');
console.log("Button HTML:");
console.log($.html(button));
