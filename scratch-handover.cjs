const fs = require('fs');
const html = fs.readFileSync('dist/index.html', 'utf8');
const match = html.match(/<script type="framer\/handover" id="__framer__handoverData">([\s\S]*?)<\/script>/);
if (match) {
  const data = JSON.parse(match[1]);
  // Look for routing or pages info
  if (data.routes) console.log("Has routes key:", Object.keys(data.routes));
  if (data.pages) console.log("Has pages key:", Object.keys(data.pages));
  
  // Just print the top-level keys
  console.log("Top-level keys:", Object.keys(data));
  
  // Look for any mention of "blog" in the JSON structure
  const findPaths = (obj, path = '') => {
    if (typeof obj === 'string' && obj.toLowerCase().includes('blog')) {
      console.log(`Found "blog" at ${path}: ${obj.substring(0, 50)}`);
    } else if (typeof obj === 'object' && obj !== null) {
      for (const key in obj) {
        findPaths(obj[key], path ? `${path}.${key}` : key);
      }
    }
  };
  
  findPaths(data);
} else {
  console.log("No handover data found");
}
