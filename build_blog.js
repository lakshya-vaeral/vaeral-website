import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const postsDir = path.join(process.cwd(), 'public', 'admin', 'data');
const templatePath = path.join(process.cwd(), 'blog', 'viral-negative', 'index.html');
const manifestPath = path.join(process.cwd(), 'public', 'admin', 'posts.json');

function buildBlogs() {
    try {
        if (!fs.existsSync(postsDir)) {
            console.log("No public/admin/data directory found. Skipping blog generation.");
            // Create empty manifest
            fs.writeFileSync(manifestPath, JSON.stringify([]));
            return;
        }

        const templateHtml = fs.readFileSync(templatePath, 'utf8');
        const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.json'));

        const manifest = [];

        if (files.length === 0) {
            console.log("No blog posts found. Skipping blog generation.");
            fs.writeFileSync(manifestPath, JSON.stringify([]));
            return;
        }

        for (const file of files) {
            const filePath = path.join(postsDir, file);
            const post = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            // Add to manifest
            manifest.push({
                title: post.title,
                slug: post.slug,
                date: post.date
            });

            console.log(`Generating HTML for: ${post.slug}`);
            const $ = cheerio.load(templateHtml);

            // 1. Replace the Title
            $('h1').first().text(post.title);
            $('title').text(post.title);
            $('meta[property="og:title"]').attr('content', post.title);
            $('meta[name="twitter:title"]').attr('content', post.title);

            // 2. Replace the Body
            const originalTextNode = $('*').filter((i, el) => $(el).text().includes("Reddit has a way of catching brands")).first();
            if (originalTextNode.length) {
                originalTextNode.parent().html(post.body);
            }

            // 3. Save the new HTML
            const outDir = path.join(process.cwd(), 'dist', 'blog', post.slug);
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'index.html'), $.html());
            
            console.log(`Saved ${post.slug} successfully!`);
        }

        // Save manifest for the Dashboard Hub
        manifest.sort((a, b) => new Date(b.date) - new Date(a.date));
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log("Saved posts.json manifest successfully.");

    } catch (err) {
        console.error("Error building blogs:", err.message);
    }
}

buildBlogs();
