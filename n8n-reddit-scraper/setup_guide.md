# n8n Reddit Scraper Setup Guide (100% API-Free)

This guide explains how to install, configure, and run the API-free Reddit Scraper workflow in n8n.

## 1. Prerequisites
- **n8n Self-Hosted** (Docker or npm). n8n Cloud will *not* work for Tier 2 and Tier 3 because it restricts the use of the Execute Command node.
- **Python 3.10+** (Required only for Tier 2/3 fallback script).
- **Node.js 18+** (Required by n8n).

## 2. Installing Python Dependencies (For Fallback Tiers)
To ensure the Tier 2 and Tier 3 fallbacks work if Reddit blocks Tier 1, install these dependencies on the server where n8n runs:

```bash
# Install the starred repositories
pip install agent-reach scrapling cloakbrowser requests

# Download required browser binaries for Scrapling
scrapling install

# Run automated setup for Agent-Reach
agent-reach install --env=auto
```

- **agent-reach**: CLI for scraping platforms without API fees (Tier 2).
- **scrapling**: Advanced HTML parser with adaptive selectors (Tier 3).
- **cloakbrowser**: Stealth Chromium browser that bypasses bot detection (Tier 3).

## 3. n8n Configuration
To run the Python fallback script, you must enable the **Execute Command** node in n8n. This is disabled by default for security.

### If running via Docker:
Add this environment variable to your `docker-compose.yml` or `docker run` command:
```env
N8N_BLOCK_EXECUTE_COMMAND=false
```

### If running via npm:
Set the environment variable before starting n8n:
```bash
export N8N_BLOCK_EXECUTE_COMMAND=false
n8n start
```

> **Warning:** Enabling Execute Command allows n8n to run shell commands on the host machine. Ensure your n8n instance is secure and not exposed to unauthorized users.

## 4. Importing the Workflow
1. Open your n8n instance.
2. Go to **Workflows** in the left menu.
3. Click **Add Workflow**.
4. In the top right, click the **three dots** (...) -> **Import from File**.
5. Select the `reddit_scraper_workflow.json` file.
6. The nodes will appear on your canvas.

## 5. Configuring the Workflow
Locate the **Configuration** node (the Set node after the triggers). You can customize these variables:

- **`subreddits`**: A comma-separated list of subreddits to scrape (e.g., `python,webdev`).
- **`posts_per_sub`**: Maximum number of posts to fetch per subreddit.
- **`sort`**: Order of posts (`hot`, `new`, `top`, `rising`, `controversial`).
- **`time_filter`**: Time range (only used for `top` and `controversial`). Valid options: `hour`, `day`, `week`, `month`, `year`, `all`.
- **`script_path`**: The absolute path to `reddit_stealth_scraper.py` on your server (e.g., `/home/user/reddit_stealth_scraper.py`).

## 6. Running the Workflow
- **Manual Test:** Click the "Test workflow" button at the bottom of the screen.
- **Scheduled:** Toggle the switch in the top right to **Active**. It will run automatically based on the Schedule Trigger (default is every 6 hours).

## 7. Connecting Output to Storage
The workflow ends at the **Create JSON File** node. You can add new nodes after **Deduplicate & Enrich** to save the data elsewhere:
- **Google Sheets:** Add the Google Sheets node to append rows.
- **PostgreSQL:** Add the Postgres node to insert data into a database.
- **Webhook / HTTP Request:** Send the JSON to an external API.

## 8. How the 3 Tiers Work
1. **Tier 1 (Reddit JSON API):** Tries to fetch `reddit.com/r/...json`. This requires no auth, but is rate-limited to ~60 requests/min. If it hits a 429 (Too Many Requests) or 403 (Forbidden), it fails over.
2. **Tier 2 (Agent-Reach):** If Tier 1 fails, the Execute Command node runs the Python script, which tries the Agent-Reach CLI. Agent-Reach is built to scrape Reddit directly.
3. **Tier 3 (CloakBrowser + Scrapling):** If Agent-Reach fails, the script uses CloakBrowser (a stealth Chromium) to load the page like a real human and Scrapling to extract the HTML data.

## 9. Troubleshooting
- **`HTTP 429` or `403`:** You are being rate-limited. Tier 2/3 will activate automatically.
- **`Command failed` in Execute Command node:** Ensure Python is installed, the script path in the Configuration node is correct, and all `pip install` commands were run.
- **`Execute Command node is disabled`:** You forgot to set `N8N_BLOCK_EXECUTE_COMMAND=false`.

## 10. Legal & Ethical Considerations
- Scraping Reddit without an official API key may violate their Terms of Service. Use at your own risk.
- Do not make excessive requests (e.g., running the scraper every minute).
- Be mindful of data privacy and avoid scraping PII.
