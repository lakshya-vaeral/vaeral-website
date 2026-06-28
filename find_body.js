import fs from 'fs';
import * as cheerio from 'cheerio';

const html = fs.readFileSync('blog/viral-negative/index.html', 'utf8');
const $ = cheerio.load(html);

const leafNodes = [];
$('*').each((i, el) => {
    if ($(el).children().length === 0 && $(el).text().includes("Reddit")) {
        leafNodes.push($(el));
    }
});

for (let i = 0; i < Math.min(5, leafNodes.length); i++) {
    const el = leafNodes[i];
    console.log(`Leaf ${i} tag: ${el[0].tagName}, class: ${el.attr('class')}`);
    console.log(`Text: ${el.text().substring(0, 50)}`);
}
