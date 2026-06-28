import fs from 'fs';
import * as cheerio from 'cheerio';

const htmlPath = 'public/admin/index.html';
let html = fs.readFileSync(htmlPath, 'utf8');

// We will inject everything at the end of the <body> so it runs after Framer hydrates (or we wait for DOMContentLoaded)

const adminUI = `
<style>
    /* OVERRIDE the Anti-Caret fix specifically for the Admin UI so they can edit */
    html, body, div, h1, h2, h3, h4, h5, h6, p, span, a, section, article, img {
        -webkit-user-select: auto !important;
        user-select: auto !important;
    }
    [contenteditable] {
        -webkit-user-modify: read-write !important;
        user-modify: read-write !important;
        caret-color: auto !important;
        outline: 2px dashed #3b82f6 !important;
        outline-offset: 4px;
        min-height: 50px;
    }

    /* Floating Action Bar */
    #vaeral-admin-bar {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #18181b;
        border: 1px solid #27272a;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.6);
        display: flex;
        gap: 16px;
        align-items: center;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: white;
    }

    #vaeral-admin-bar input {
        background: #09090b;
        border: 1px solid #27272a;
        color: white;
        padding: 8px 12px;
        border-radius: 6px;
        outline: none;
    }

    #vaeral-admin-bar input:focus {
        border-color: #3b82f6;
    }

    #vaeral-admin-bar button {
        background: #ffffff;
        color: #000000;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
    }

    #vaeral-admin-bar button:hover {
        background: #e4e4e7;
    }

    #vaeral-admin-bar .btn-secondary {
        background: #27272a;
        color: white;
    }
    #vaeral-admin-bar .btn-secondary:hover {
        background: #3f3f46;
    }
</style>

<div id="vaeral-admin-bar">
    <div style="font-weight: bold; margin-right: 8px;">LIVE ADMIN</div>
    <input type="password" id="admin-pass" placeholder="Password" required>
    <input type="text" id="admin-slug" placeholder="url-slug" required>
    <button type="button" class="btn-secondary" id="admin-img-btn">Add Image</button>
    <button type="button" id="admin-publish-btn">Publish</button>
</div>

<script>
    // Wait a moment for Framer to finish hydration/rendering
    setTimeout(() => {
        // 1. Make Title Editable
        const h1 = document.querySelector('h1');
        if (h1) {
            h1.setAttribute('contenteditable', 'true');
            h1.id = 'admin-title';
            // Stop Framer from hijacking enter key
            h1.addEventListener('keydown', e => e.stopPropagation());
        }

        // 2. Find Body Container and make editable
        // We look for the text "Reddit has a way" to find the parent container
        const allElements = Array.from(document.querySelectorAll('*'));
        const originalTextNode = allElements.find(el => el.textContent && el.textContent.includes("Reddit has a way") && el.children.length === 0);
        
        let bodyContainer = null;
        if (originalTextNode) {
            bodyContainer = originalTextNode.parentElement;
            bodyContainer.setAttribute('contenteditable', 'true');
            bodyContainer.id = 'admin-body';
            bodyContainer.addEventListener('keydown', e => e.stopPropagation());
        }

        // 3. Add Image Logic
        document.getElementById('admin-img-btn').addEventListener('click', () => {
            const url = prompt("Enter Image URL (e.g., https://imgur.com/image.png):");
            if (url) {
                // Restore selection to the body if possible, or just append
                document.execCommand('insertImage', false, url);
                
                // Framer images usually need max-width 100%
                const imgs = bodyContainer.querySelectorAll('img');
                imgs.forEach(img => {
                    img.style.maxWidth = '100%';
                    img.style.borderRadius = '8px';
                    img.style.marginTop = '20px';
                    img.style.marginBottom = '20px';
                });
            }
        });

        // 4. Publish Logic
        document.getElementById('admin-publish-btn').addEventListener('click', async () => {
            const btn = document.getElementById('admin-publish-btn');
            const pass = document.getElementById('admin-pass').value;
            const slug = document.getElementById('admin-slug').value;
            
            if (!pass || !slug) {
                alert("Password and Slug are required.");
                return;
            }

            const title = document.getElementById('admin-title').innerText;
            const body = document.getElementById('admin-body').innerHTML;

            btn.innerText = "Publishing...";
            btn.disabled = true;

            try {
                const response = await fetch('/api/publish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pass, title: title, slug: slug, body: body })
                });

                const data = await response.json();
                if (response.ok) {
                    alert("Published successfully! Vercel is rebuilding.");
                    btn.innerText = "Published!";
                } else {
                    alert("Error: " + (data.error || 'Failed'));
                    btn.innerText = "Publish";
                    btn.disabled = false;
                }
            } catch (err) {
                alert("Network Error: " + err.message);
                btn.innerText = "Publish";
                btn.disabled = false;
            }
        });

    }, 1500); // Wait 1.5s for Framer React hydration
</script>
`;

// Insert right before </body>
html = html.replace('</body>', adminUI + '\n</body>');
fs.writeFileSync(htmlPath, html);
console.log("Injected Live Preview Admin UI!");
