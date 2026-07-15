const fs = require('fs');
const html = fs.readFileSync('dist/index.html', 'utf8');

// Print out body open and end
const bodyStart = html.indexOf('<body');
console.log("Body Start:");
console.log(html.substring(bodyStart, bodyStart + 150));

const bodyEnd = html.lastIndexOf('</body>');
console.log("\nBody End:");
console.log(html.substring(bodyEnd - 300, bodyEnd + 10));
