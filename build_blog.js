import fs from 'fs';
import path from 'path';
import { createClient } from '@sanity/client';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
dotenv.config();

// Initialize Sanity Client
// We use process.env to allow the user to supply these via Vercel later
const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID || 'your_project_id',
  dataset: process.env.SANITY_DATASET || 'production',
  useCdn: false, // Ensure fresh data on build
  apiVersion: '2024-01-01',
});

// Read the master template (the viral-negative blog we perfected)
const templatePath = path.join(process.cwd(), 'blog', 'viral-negative', 'index.html');
const templateHtml = fs.readFileSync(templatePath, 'utf8');

async function buildBlogs() {
    try {
        console.log("Fetching blog posts from Sanity...");
        // Query Sanity for all blog posts
        // This query expects a 'post' schema with title, slug, body, etc.
        const posts = await client.fetch(`*[_type == "post"]{
            title,
            "slug": slug.current,
            body
        }`);

        if (!posts || posts.length === 0) {
            console.log("No blog posts found in Sanity. Skipping blog generation.");
            return;
        }

        for (const post of posts) {
            console.log(`Generating HTML for: ${post.slug}`);
            const $ = cheerio.load(templateHtml);

            // 1. Replace the Title
            $('h1').first().text(post.title);
            $('title').text(post.title);
            $('meta[property="og:title"]').attr('content', post.title);
            $('meta[name="twitter:title"]').attr('content', post.title);

            // 2. Replace the Body
            // Framer encapsulates the rich text in a specific div.
            // We find the parent container of the original article text.
            const originalTextNode = $('*').filter((i, el) => $(el).text().includes("Reddit has a way of catching brands")).first();
            if (originalTextNode.length) {
                // Here you would convert the Sanity Portable Text 'post.body' to HTML
                // For simplicity in this skeleton, we inject raw HTML if it was provided,
                // or just stringify the block. A proper Portable Text to HTML converter 
                // like @portabletext/to-html should be used for rich text formatting.
                const simpleBodyHtml = post.body.map(block => `<p class="${originalTextNode.attr('class')}">${block.children.map(c => c.text).join('')}</p>`).join('');
                originalTextNode.parent().html(simpleBodyHtml);
            }

            // 3. Save the new HTML
            const outDir = path.join(process.cwd(), 'dist', 'blog', post.slug);
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'index.html'), $.html());
            
            console.log(`Saved ${post.slug} successfully!`);
        }
    } catch (err) {
        // If the project ID isn't set, it will fail gracefully here
        console.error("Error building blogs. Make sure SANITY_PROJECT_ID is configured:", err.message);
    }
}

buildBlogs();
