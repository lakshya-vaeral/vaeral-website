const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('.framer-1tpw1b9').each((i, el) => {
  let cur = $(el);
  let isNav = false;
  let isHeader = false;
  let isFooter = false;
  while(cur.length && cur[0].name && cur[0].name !== 'body') {
    if(cur[0].name === 'nav') isNav = true;
    if(cur[0].name === 'header') isHeader = true;
    if(cur[0].name === 'footer') isFooter = true;
    cur = cur.parent();
  }
  console.log('Index:', i, 'In Nav?', isNav, 'In Header?', isHeader, 'In Footer?', isFooter);
});
