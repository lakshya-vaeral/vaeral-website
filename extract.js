import fs from 'fs';

const html = fs.readFileSync('vaeral_live.html', 'utf8');

// Extract all style tags
const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/g;
let match;
let allCss = '';

while ((match = styleRegex.exec(html)) !== null) {
    allCss += match[1] + '\n';
}

// Pretty print simple CSS (rough)
let prettyCss = allCss
    .replace(/}/g, '}\n')
    .replace(/{/g, ' {\n    ')
    .replace(/;/g, ';\n    ');

fs.writeFileSync('extracted_styles.css', prettyCss);

console.log('Extraction complete. Saved to extracted_styles.css');
