export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { password, title, slug, body } = req.body;

    // Verify Password
    const correctPassword = process.env.ADMIN_PASSWORD;
    if (!correctPassword || password !== correctPassword) {
        return res.status(401).json({ error: 'Unauthorized: Incorrect Password' });
    }

    // Validate inputs
    if (!title || !slug || !body) {
        return res.status(400).json({ error: 'Missing title, slug, or body' });
    }

    const githubToken = process.env.GITHUB_PAT;
    const githubRepo = process.env.GITHUB_REPO; // e.g., "lakshya-vaeral/vaeral-website"

    if (!githubToken || !githubRepo) {
        return res.status(500).json({ error: 'GitHub credentials not configured on the server.' });
    }

    try {
        const filePath = `public/admin/data/${slug}.json`;
        const fileContent = JSON.stringify({ title, slug, body, date: new Date().toISOString() }, null, 2);
        const encodedContent = Buffer.from(fileContent).toString('base64');

        // Check if file already exists to get its SHA (required for updating)
        const fileUrl = `https://api.github.com/repos/${githubRepo}/contents/${filePath}`;
        const existingFileRes = await fetch(fileUrl, {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'Vercel-Git-CMS'
            }
        });

        let sha = null;
        if (existingFileRes.ok) {
            const data = await existingFileRes.json();
            sha = data.sha;
        }

        // Commit the file
        const commitRes = await fetch(fileUrl, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'Vercel-Git-CMS',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: `cms: publish blog post ${slug}`,
                content: encodedContent,
                sha: sha, // Only included if file exists
                branch: 'main'
            })
        });

        if (!commitRes.ok) {
            const errorText = await commitRes.text();
            throw new Error(`GitHub API Error: ${errorText}`);
        }

        return res.status(200).json({ success: true, message: 'Blog post published successfully! Vercel is now rebuilding the site.' });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
