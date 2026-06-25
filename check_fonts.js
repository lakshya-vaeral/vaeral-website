import fs from 'fs';

const html = fs.readFileSync('vaeral_live.html', 'utf8');

const regex = /<(h1|h2|h3|p|a|span)[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
let match;
const tags = {};

while ((match = regex.exec(html)) !== null) {
    const tag = match[1];
    const style = match[2];
    
    let fontMatch = /--framer-font-family:([^;]+)/.exec(style);
    let sizeMatch = /--framer-font-size:([^;]+)/.exec(style);
    let weightMatch = /--framer-font-weight:([^;]+)/.exec(style);
    
    if (fontMatch || sizeMatch) {
        if (!tags[tag]) tags[tag] = [];
        const entry = {
            font: fontMatch ? fontMatch[1].replace(/&quot;/g, '"') : '',
            size: sizeMatch ? sizeMatch[1] : '',
            weight: weightMatch ? weightMatch[1] : ''
        };
        // Only push unique
        if (!tags[tag].find(e => e.font === entry.font && e.size === entry.size && e.weight === entry.weight)) {
            tags[tag].push(entry);
        }
    }
}

console.log(JSON.stringify(tags, null, 2));
