const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('nav a[href="#contact"]').each((i, el) => {
    console.log(`\n--- Nav Match ${i} ---`);
    console.log('Parent classes:', $(el).parent().attr('class'));
    console.log('Parent outerHTML:', $(el).parent().parent().html());
});
