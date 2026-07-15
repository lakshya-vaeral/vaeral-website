const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

const button = $('a:contains("View all posts")');
const wrapper = button.parent();
console.log("Button Wrapper classes:", wrapper.attr('class'));
console.log("Button Wrapper styling:", wrapper.attr('style'));
console.log("Button Wrapper HTML:", $.html(wrapper));
