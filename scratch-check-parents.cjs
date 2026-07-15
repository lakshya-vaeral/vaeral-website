const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

const grid = $('.framer-fbd1z7');
if (grid.length) {
    let parent = grid.parent();
    console.log("Parent 1 classes:", parent.attr('class'));
    console.log("Parent 1 style:", parent.attr('style'));
    
    parent = parent.parent();
    console.log("Parent 2 classes:", parent.attr('class'));
    console.log("Parent 2 style:", parent.attr('style'));

    parent = parent.parent();
    console.log("Parent 3 classes:", parent.attr('class'));
    console.log("Parent 3 style:", parent.attr('style'));
}
