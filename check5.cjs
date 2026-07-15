const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('.framer-1tpw1b9').each((i, el) => {
  let parent = $(el).parent().parent().parent();
  console.log('Context for', i, ':', parent.text().substring(0, 100).replace(/\n/g, ' '));
});
