const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

let matched = 0;
$('nav a[href="#contact"]').each((i, el) => {
    const text = $(el).text().trim();
    if (text === 'Contact') {
        matched++;
        console.log(`Match ${matched}: found link inside`, $(el).parents('nav').attr('class'));
    }
});
console.log(`Total matches: ${matched}`);
