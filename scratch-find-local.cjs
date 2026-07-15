const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

const el = $('*:contains("B2B Fintech Platform")').last();
let parent = el.parent();
for(let i=0; i<15; i++) { 
    if(parent.length) { 
        console.log('Parent', i, 'classes:', parent.attr('class')); 
        parent = parent.parent(); 
    } 
}
