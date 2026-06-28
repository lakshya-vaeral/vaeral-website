import fs from 'fs';
import * as cheerio from 'cheerio';

const html = fs.readFileSync('blog/viral-negative/index.html', 'utf8');
const $ = cheerio.load(html);

console.log("Number of <img> tags:", $('img').length);
console.log("Number of elements with background-image:", $('*').filter((i, el) => $(el).attr('style')?.includes('background-image')).length);

// Let's also check the actual body structure.
const bodyNodes = $('*').filter((i, el) => $(el).text().includes("Reddit has a way of catching brands")).first().parent().children();
console.log("Article Body children count:", bodyNodes.length);
bodyNodes.each((i, el) => {
    console.log(`Node ${i}: <${el.tagName}>, text snippet: ${$(el).text().substring(0, 30)}`);
});
