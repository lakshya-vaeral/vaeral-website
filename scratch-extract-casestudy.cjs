const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

const section = $('.framer-mopmot').first();
if (section.length) {
    console.log("Section found.");
    // The section usually contains a grid. Let's find the case study cards inside it.
    // The first link to ./online-pharmacy is inside the first card.
    const firstLink = section.find('a[href*="online-pharmacy"]').first();
    const card = firstLink.closest('div[class^="framer-"]'); // Not sure which div is the card wrapper, let's just print the link's parent structure.
    
    // Print the HTML of the section up to a certain depth or length
    console.log("Section HTML preview:");
    console.log(section.html().substring(0, 1500));
}
