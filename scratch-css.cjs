const fs = require('fs');

const html = fs.readFileSync('dist/index.html', 'utf8');

const classes = ['framer-mopmot', 'framer-q8qjq9', 'framer-12qck6g', 'framer-2p1oou', 'framer-fbd1z7'];

for (const cls of classes) {
    const regex = new RegExp(`\\.${cls}\\s*{[^}]*}`, 'g');
    const matches = html.match(regex);
    if (matches) {
        console.log(`\n--- CSS for ${cls} ---`);
        matches.forEach(m => console.log(m));
    }
}
