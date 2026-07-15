const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

const navContainers = [];

$('a[href="#contact"]').each((i, el) => {
    let parent = $(el).parent();
    while (parent.length) {
        // If this parent also contains #about and #portfolio
        if (parent.find('a[href="#about"]').length > 0 && parent.find('a[href="#portfolio"]').length > 0) {
            console.log(`Found true nav container at Match ${i+1}. Classes:`, parent.attr('class'));
            break;
        }
        parent = parent.parent();
    }
});
