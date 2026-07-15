const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('dist/index.html', 'utf8');
const $ = cheerio.load(html);

// Find the section that actually wraps the case studies
// The link is `./online-pharmacy`. Let's find its parent.
const firstCaseStudyLink = $('a[href*="online-pharmacy"]').first();
// Let's traverse up to find a container with multiple children (the grid)
let gridContainer = firstCaseStudyLink.parent();
while (gridContainer.length && gridContainer.children().length < 2) {
    gridContainer = gridContainer.parent();
}

console.log("Grid Container classes:", gridContainer.attr('class'));
console.log("Grid Container tag:", gridContainer.prop('tagName'));
console.log("Number of case studies found:", gridContainer.children().length);

// Print the HTML of the first child (a case study card)
console.log("\nFirst Case Study Card HTML:");
console.log(gridContainer.children().first().html().substring(0, 500));
