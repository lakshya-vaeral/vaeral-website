const fs = require('fs');
const cheerio = require('cheerio');
const files = ['dist/index.html', 'templates/blog.html', 'templates/case-study.html', 'templates/blog-index.html'];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  const $ = cheerio.load(html);
  console.log(`\n--- Links in ${file} ---`);
  const uniqueLinks = new Set();
  $('a').each((i, el) => {
    let href = $(el).attr('href');
    if (href && (href.startsWith('/') || href.startsWith('.'))) {
      uniqueLinks.add(href);
    }
  });
  for (const href of uniqueLinks) {
    console.log(href);
  }
}
