const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

// Find all links containing exactly "Contact"
$('a').each((i, el) => {
    const text = $(el).text().trim();
    if (text === 'Contact') {
        console.log(`\n--- Match ${i + 1} ---`);
        console.log("Classes:", $(el).attr('class'));
        console.log("Href:", $(el).attr('href'));
        console.log("HTML length:", $.html(el).length);
        console.log("Parent HTML:", $.html($(el).parent()));
    }
});
