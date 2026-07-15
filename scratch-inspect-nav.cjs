const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

$('nav').each((i, el) => {
    console.log(`\n--- NAV ${i + 1} ---`);
    console.log("Nav classes:", $(el).attr('class'));
    console.log("Contains #contact?", $(el).find('a[href="#contact"]').length > 0);
    console.log("Contains #about?", $(el).find('a[href="#about"]').length > 0);
    console.log("Contains #portfolio?", $(el).find('a[href="#portfolio"]').length > 0);
    console.log("HTML length:", $.html(el).length);
});
