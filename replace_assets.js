import fs from 'fs';

let html = fs.readFileSync('index.html', 'utf8');

// Map what we know
const map = {
    'mxApJNEyaqa0EEnfiAbWSEiVOo.svg': '/assets/vaeral-logo.svg',
    'ySFUxpFjfOjKh39rfMqBFiv6pzM.png': '/assets/og-image.png',
    'xvfgPpvbsHYOSC0sX5ap2sPVC90.png': '/assets/favicon.png',
};

// I will just blindly replace any reference to these specific filenames with our local paths.
for (const [framer, local] of Object.entries(map)) {
    // Replace exactly the URL or just the id if it has ?width= etc.
    const regex = new RegExp(`https://framerusercontent.com/images/${framer}[^"'\s]*`, 'g');
    html = html.replace(regex, local);
    
    // Also handle assets path
    const assetRegex = new RegExp(`https://framerusercontent.com/assets/${framer}[^"'\s]*`, 'g');
    html = html.replace(assetRegex, local);
}

// For the rest, we can try to guess based on context, but let's just do these for now.
// I will also inject a small script to remove the Framer editor overlay if it exists.

fs.writeFileSync('index.html', html);
console.log('Replaced known images in index.html');
