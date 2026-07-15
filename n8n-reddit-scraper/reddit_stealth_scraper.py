import json
import sys
import argparse
import time
import subprocess
from datetime import datetime

# Optional dependencies
try:
    from scrapling.fetchers import StealthyFetcher
    HAS_SCRAPLING = True
except ImportError:
    HAS_SCRAPLING = False

try:
    from cloakbrowser import launch
    HAS_CLOAKBROWSER = True
except ImportError:
    HAS_CLOAKBROWSER = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

def log(msg):
    # Log to stderr so it doesn't corrupt stdout JSON output
    print(f"[INFO] {msg}", file=sys.stderr)

def log_error(msg):
    print(f"[ERROR] {msg}", file=sys.stderr)

def parse_args():
    parser = argparse.ArgumentParser(description="Fallback Reddit Scraper (API-Free)")
    parser.add_argument("--subreddits", type=str, required=True, help="Comma-separated list of subreddits")
    parser.add_argument("--limit", type=int, default=100, help="Max posts to scrape per subreddit")
    parser.add_argument("--sort", type=str, default="hot", choices=["hot", "new", "top", "rising", "controversial"])
    parser.add_argument("--time_filter", type=str, default="week", choices=["hour", "day", "week", "month", "year", "all"])
    return parser.parse_args()

def strategy_a_agent_reach(subreddit, limit):
    """Tier 2: Use Agent-Reach CLI if installed"""
    log(f"Trying Strategy A (Agent-Reach) for r/{subreddit}")
    try:
        # Agent-Reach uses `rdt search` command
        # It's an AI agent toolkit, zero fees
        cmd = ["rdt", "search", f"subreddit:{subreddit}", "--limit", str(limit)]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        # Assuming agent-reach outputs JSON or parsable text, but since we don't have exact JSON format for rdt
        # Let's try to parse if it's JSON
        try:
            data = json.loads(result.stdout)
            # Adapt schema if needed, assuming it's somewhat structured
            posts = []
            for item in data:
                posts.append(format_post(item, 'tier_2_agent_reach'))
            return posts
        except json.JSONDecodeError:
            log_error("Agent-Reach output was not JSON.")
            return None
    except FileNotFoundError:
        log_error("Agent-Reach CLI (rdt) not found.")
        return None
    except subprocess.CalledProcessError as e:
        log_error(f"Agent-Reach failed: {e.stderr}")
        return None
    except Exception as e:
        log_error(f"Agent-Reach unexpected error: {e}")
        return None

def strategy_b_scrapling(subreddit, sort, time_filter, limit):
    """Tier 3: Scrapling StealthyFetcher on old.reddit.com"""
    if not HAS_SCRAPLING:
        log_error("Scrapling not installed.")
        return None
    
    log(f"Trying Strategy B (Scrapling) for r/{subreddit}")
    try:
        fetcher = StealthyFetcher(headless=True)
        url = f"https://old.reddit.com/r/{subreddit}/{sort}/"
        if sort in ['top', 'controversial']:
            url += f"?sort={sort}&t={time_filter}"
            
        page = fetcher.fetch(url)
        posts_html = page.css('.thing')
        
        posts = []
        for p in posts_html[:limit]:
            title = p.css('p.title > a.title::text').get()
            author = p.css('p.tagline > a.author::text').get()
            score_unparsed = p.css('.score.unvoted::text').get()
            url_link = p.css('p.title > a.title::attr(href)').get()
            comments = p.css('a.comments::text').get()
            post_id = p.css('::attr(data-fullname)').get()
            permalink = p.css('::attr(data-permalink)').get()
            time_element = p.css('time::attr(datetime)').get()
            
            score = 0
            if score_unparsed and score_unparsed.isdigit():
                score = int(score_unparsed)
            
            num_comments = 0
            if comments:
                comments_text = comments.split(' ')[0]
                if comments_text.isdigit():
                    num_comments = int(comments_text)
            
            created_utc = 0
            if time_element:
                dt = datetime.fromisoformat(time_element.replace("Z", "+00:00"))
                created_utc = dt.timestamp()

            post = {
                "id": post_id.replace('t3_', '') if post_id else "",
                "fullname": post_id or "",
                "subreddit": subreddit,
                "title": title or "",
                "author": author or "",
                "score": score,
                "num_comments": num_comments,
                "created_utc": created_utc,
                "created_date": time_element or "",
                "url": url_link or "",
                "permalink": f"https://reddit.com{permalink}" if permalink else "",
                "scrape_tier": "tier_3_scrapling",
                "scraped_at": datetime.utcnow().isoformat()
            }
            posts.append(post)
            
        return posts
    except Exception as e:
        log_error(f"Scrapling failed: {e}")
        return None

def strategy_c_cloakbrowser(subreddit, limit):
    """Tier 3: CloakBrowser fallback"""
    if not HAS_CLOAKBROWSER:
        log_error("CloakBrowser not installed.")
        return None
    
    log(f"Trying Strategy C (CloakBrowser) for r/{subreddit}")
    try:
        browser = launch(headless=True, humanize=True)
        page = browser.new_page()
        page.goto(f"https://old.reddit.com/r/{subreddit}/")
        
        # Simple extraction using Playwright API
        # old.reddit is easier to scrape than new reddit
        post_elements = page.query_selector_all('.thing')
        posts = []
        for p in post_elements[:limit]:
            title_el = p.query_selector('p.title > a.title')
            title = title_el.inner_text() if title_el else ""
            posts.append({
                "id": p.get_attribute("data-fullname"),
                "subreddit": subreddit,
                "title": title,
                "scrape_tier": "tier_3_cloakbrowser",
                "scraped_at": datetime.utcnow().isoformat()
            })
            
        browser.close()
        return posts
    except Exception as e:
        log_error(f"CloakBrowser failed: {e}")
        return None

def strategy_d_requests(subreddit, sort, time_filter, limit):
    """Tier 4: Basic HTTP requests to old.reddit JSON"""
    if not HAS_REQUESTS:
        log_error("Requests not installed.")
        return None
        
    log(f"Trying Strategy D (Basic Requests) for r/{subreddit}")
    try:
        url = f"https://old.reddit.com/r/{subreddit}/{sort}.json?limit={limit}"
        if sort in ['top', 'controversial']:
            url += f"&t={time_filter}"
            
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            posts = []
            for child in data.get('data', {}).get('children', []):
                d = child['data']
                posts.append({
                    "id": d.get('id'),
                    "fullname": d.get('name'),
                    "subreddit": d.get('subreddit'),
                    "title": d.get('title'),
                    "author": d.get('author'),
                    "score": d.get('score'),
                    "num_comments": d.get('num_comments'),
                    "created_utc": d.get('created_utc'),
                    "url": d.get('url'),
                    "permalink": f"https://reddit.com{d.get('permalink')}",
                    "scrape_tier": "tier_4_requests",
                    "scraped_at": datetime.utcnow().isoformat()
                })
            return posts
        else:
            log_error(f"Requests failed with status {response.status_code}")
            return None
    except Exception as e:
        log_error(f"Requests failed: {e}")
        return None

def format_post(item, tier):
    """Ensure standard schema"""
    return {
        "id": item.get('id', ''),
        "subreddit": item.get('subreddit', ''),
        "title": item.get('title', ''),
        "author": item.get('author', ''),
        "score": item.get('score', 0),
        "num_comments": item.get('num_comments', 0),
        "created_utc": item.get('created_utc', 0),
        "url": item.get('url', ''),
        "permalink": item.get('permalink', ''),
        "scrape_tier": tier,
        "scraped_at": datetime.utcnow().isoformat()
    }

def main():
    args = parse_args()
    subreddits = [s.strip() for s in args.subreddits.split(',')]
    all_posts = []

    for sub in subreddits:
        posts = None
        # Try strategies in order
        posts = strategy_a_agent_reach(sub, args.limit)
        if not posts:
            posts = strategy_b_scrapling(sub, args.sort, args.time_filter, args.limit)
        if not posts:
            posts = strategy_c_cloakbrowser(sub, args.limit)
        if not posts:
            posts = strategy_d_requests(sub, args.sort, args.time_filter, args.limit)
            
        if posts:
            all_posts.extend(posts)
        else:
            log_error(f"All fallback strategies failed for r/{sub}")

    # Output JSON to stdout (this is what n8n parses)
    print(json.dumps(all_posts, indent=2))

if __name__ == "__main__":
    main()
