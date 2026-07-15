const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('scratch-live.html', 'utf8');
const $ = cheerio.load(html);

// Find a case study title that we know is on the homepage
const el = $('*:contains("B2B Fintech Platform")').last();
if (el.length) {
    let parent = el.parent();
    for (let i = 0; i < 5; i++) {
        if (parent.length) {
            console.log(`Parent ${i} classes:`, parent.attr('class'));
            parent = parent.parent();
        }
    }
} else {
    console.log("Could not find the text!");
}
