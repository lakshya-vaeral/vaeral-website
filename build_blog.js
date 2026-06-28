import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const postsDir = path.join(process.cwd(), 'data', 'posts');
const templatePath = path.join(process.cwd(), 'blog', 'viral-negative', 'index.html');

function buildBlogs() {
    try {
        if (!fs.existsSync(postsDir)) {
            console.log("No data/posts directory found. Skipping blog generation.");
            return;
        }

        const templateHtml = fs.readFileSync(templatePath, 'utf8');
        const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.json'));

        if (files.length === 0) {
            console.log("No blog posts found in data/posts. Skipping blog generation.");
            return;
        }

        for (const file of files) {
            const filePath = path.join(postsDir, file);
            const post = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            console.log(`Generating HTML for: ${post.slug}`);
            const $ = cheerio.load(templateHtml);

            // 1. Replace the Title
            $('h1').first().text(post.title);
            $('title').text(post.title);
            $('meta[property="og:title"]').attr('content', post.title);
            $('meta[name="twitter:title"]').attr('content', post.title);

            // 2. Replace the Body
            // We find the parent container of the original article text.
            const originalTextNode = $('*').filter((i, el) => $(el).text().includes("Reddit has a way of catching brands")).first();
            if (originalTextNode.length) {
                // The body is exactly the innerHTML of the container from the Live Preview editor
                originalTextNode.parent().html(post.body);
            }

            // 3. Save the new HTML
            const outDir = path.join(process.cwd(), 'dist', 'blog', post.slug);
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'index.html'), $.html());
            
            console.log(`Saved ${post.slug} successfully!`);
        }
    } catch (err) {
        console.error("Error building blogs:", err.message);
    }
}

buildBlogs();
