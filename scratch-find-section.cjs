const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

// Find any links containing 'casestudies' or 'online-pharmacy'
console.log("Links with 'casestudies':");
$('a[href*="casestudies"]').each((i, el) => console.log($(el).attr('href')));

console.log("\nLinks with 'online-pharmacy':");
$('a[href*="online-pharmacy"]').each((i, el) => console.log($(el).attr('href')));

// Find the section that has the case studies
// Usually Framer sections have an id. Let's look for id="casestudies" or similar
const section = $('[id*="casestudies"], [name*="casestudies"], a[href="#casestudies"]').closest('section, div.framer-section');
if (section.length) {
    console.log(`\nFound case studies section. Classes: ${section.attr('class')}`);
} else {
    console.log("\nCould not find a section containing case studies.");
}
