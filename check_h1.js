import fs from 'fs';

const html = fs.readFileSync('vaeral_live.html', 'utf8');

const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/g;
const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/g;

let match;
while ((match = h1Regex.exec(html)) !== null) {
    console.log('H1:', match[0].substring(0, 300));
}

while ((match = h2Regex.exec(html)) !== null) {
    console.log('H2:', match[0].substring(0, 150));
}
