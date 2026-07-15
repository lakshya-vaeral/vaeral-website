const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

$('a[href="#contact"]').each((i, el) => {
    console.log(`\n--- Match ${i + 1} ---`);
    let parent = $(el).parent();
    for (let j = 0; j < 6; j++) {
        if (parent.length) {
            console.log(`Parent ${j} classes:`, parent.attr('class'));
            parent = parent.parent();
        }
    }
});
