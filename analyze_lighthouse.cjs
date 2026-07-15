const fs = require('fs');
const lh = JSON.parse(fs.readFileSync('lighthouse_mobile.json', 'utf8'));

console.log('--- LCP Element ---');
const lcp = lh.audits['largest-contentful-paint-element'];
if (lcp && lcp.details && lcp.details.items) {
  console.log(JSON.stringify(lcp.details.items, null, 2));
}

console.log('\n--- Network Requests ---');
const network = lh.audits['network-requests'];
if (network && network.details && network.details.items) {
  network.details.items
    .filter(req => req.transferSize > 50000) // only >50KB
    .sort((a, b) => b.transferSize - a.transferSize)
    .forEach(req => console.log(`${Math.round(req.transferSize/1024)} KB : ${req.url}`));
}

console.log('\n--- Unused JS ---');
const unused = lh.audits['unused-javascript'];
if (unused && unused.details && unused.details.items) {
  unused.details.items.forEach(req => console.log(`Unused ${Math.round(req.wastedBytes/1024)} KB : ${req.url}`));
}
