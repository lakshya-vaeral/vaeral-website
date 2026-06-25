import fs from 'fs';

const html = fs.readFileSync('vaeral_live.html', 'utf8');

const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/g;
let match;
let count = 0;
while ((match = pRegex.exec(html)) !== null && count < 5) {
    console.log('P:', match[0].substring(0, 300));
    count++;
}
