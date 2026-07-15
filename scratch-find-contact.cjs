const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('index.html', 'utf8');
const $ = cheerio.load(html);

$('a').each((i, el) => {
    if ($(el).text().includes('Contact')) {
        console.log(`\n--- Match ${i} ---`);
        console.log($(el).parent().parent().html());
    }
});
