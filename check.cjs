const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('span, p, a').each((i, el) => {
  if ($(el).text().trim() === 'Blogs') {
    let cur = $(el);
    let path = [];
    while (cur.length && cur[0].name && cur[0].name !== 'body' && path.length < 6) {
      path.push(cur[0].name + (cur.attr('class') ? '.' + cur.attr('class').split(' ').join('.') : ''));
      cur = cur.parent();
    }
    console.log(path.reverse().join(' > '));
  }
});
