const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory() && !file.includes('.git') && !file.includes('node_modules')) {
      results = results.concat(walk(file));
    } else if (stat.isFile()) {
      results.push(file);
    }
  });
  return results;
}

const target1 = 'sNRPyFTcLx6lSXgb3zHBD7olQLI';
const target2 = 'u4hHbNu6CexwFHYVqPyhIIptLLY';

walk('.').forEach(f => {
  try {
    const content = fs.readFileSync(f, 'utf8');
    if (content.includes(target1) || content.includes(target2)) {
      console.log('FOUND IN', f);
      const regex1 = new RegExp(target1 + '[a-zA-Z0-9.-]*', 'g');
      const regex2 = new RegExp(target2 + '[a-zA-Z0-9.-]*', 'g');
      const m1 = content.match(regex1);
      const m2 = content.match(regex2);
      if (m1) console.log('  Matches for 1:', [...new Set(m1)]);
      if (m2) console.log('  Matches for 2:', [...new Set(m2)]);
    }
  } catch(e) {}
});
