const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const bravePaths = [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(process.env.LOCALAPPDATA, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
];

let executablePath = bravePaths.find(p => fs.existsSync(p));

(async () => {
    const browser = await puppeteer.launch({ executablePath, headless: 'new' });
    const page = await browser.newPage();
    
    // assuming local server is running on 3000, or I can use file://
    await page.goto('file:///c:/Users/laksh/Documents/VAERAL/dist/index.html', { waitUntil: 'networkidle0' });
    
    // Wait for React to render
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const formInfo = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        return forms.map(f => {
            const inputs = Array.from(f.querySelectorAll('input, textarea, select')).map(i => ({
                name: i.name,
                type: i.type,
                placeholder: i.placeholder,
                id: i.id,
                className: i.className
            }));
            const buttons = Array.from(f.querySelectorAll('button, input[type="submit"]')).map(b => ({
                text: b.innerText || b.value,
                type: b.type
            }));
            return {
                action: f.action,
                method: f.method,
                className: f.className,
                inputs,
                buttons
            };
        });
    });
    
    fs.writeFileSync('form_data.json', JSON.stringify(formInfo, null, 2));
    console.log('Form data extracted:', formInfo);
    
    await browser.close();
})();
