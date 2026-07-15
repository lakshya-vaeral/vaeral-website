const fs = require('fs');
const html = fs.readFileSync('dist/blog/test-blog-1/index.html', 'utf8');

const idx = html.indexOf('data-framer-name="Newsletter"');
if (idx !== -1) {
    console.log(html.substring(Math.max(0, idx - 1500), idx));
} else {
    console.log("Not found");
}
