import fs from 'fs';

const html = fs.readFileSync('vaeral_live.html', 'utf8');

const imgRegex = /<img[^>]+src="([^">]+)"/g;
let match;
const sources = new Set();
while ((match = imgRegex.exec(html)) !== null) {
    sources.add(match[1]);
}

const bgRegex = /background-image:\s*url\(([^)]+)\)/g;
while ((match = bgRegex.exec(html)) !== null) {
    sources.add(match[1].replace(/["']/g, ''));
}

console.log(Array.from(sources).join('\n'));
