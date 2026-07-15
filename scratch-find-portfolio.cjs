const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

$('nav').each((i, el) => {
    console.log(`\n--- NAV ${i + 1} ---`);
    const links = $(el).find('a');
    links.each((j, a) => {
        console.log(`Link ${j}: text="${$(a).text().trim()}", href="${$(a).attr('href')}"`);
    });
});
