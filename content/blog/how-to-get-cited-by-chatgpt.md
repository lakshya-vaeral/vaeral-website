---
title: "How to get cited by ChatGPT"
seoTitle: "How to Get Cited by ChatGPT | Vaeral"
slug: how-to-get-cited-by-chatgpt
date: 2026-10-21
description: Most advice gets the crawler wrong. The bot deciding whether ChatGPT can cite you is not the one most sites block. Here is what actually governs it.
coverImage: /assets/blog-reddit-marketing.jpg
draft: false
tags:
  - ChatGPT
  - AI Search
  - AEO
faqs:
  - question: Which crawler decides whether ChatGPT can cite my site?
    answer: OAI-SearchBot. OpenAI's documentation states plainly that OAI-SearchBot
      is for search and surfaces websites in ChatGPT's search features. GPTBot
      is the separate crawler for training foundation models. Blocking GPTBot
      does not remove you from ChatGPT's search results.
  - question: If I block GPTBot, will I disappear from ChatGPT?
    answer: No. They are independent settings. OpenAI's documentation says each
      setting is independent of the others, so a site can refuse training use
      via GPTBot while remaining fully citable in ChatGPT search via
      OAI-SearchBot.
  - question: Does allowing OAI-SearchBot mean my content is used for training?
    answer: OpenAI does not say it is excluded. The documentation describes
      OAI-SearchBot as being for search, but it also notes that where both
      crawlers are allowed, results from one crawl may be used for both
      purposes. Treat the two as independent permissions, not as a guarantee
      of separation.
  - question: What is ChatGPT-User?
    answer: It is the fetch that happens when a person asks ChatGPT to look at a
      page. OpenAI states it is not used for crawling the web in an automatic
      fashion, so it is a response to a user action rather than a crawler
      building an index.
  - question: Can I force ChatGPT to cite my company?
    answer: No, and treat anyone claiming otherwise with suspicion. You can make a
      page reachable, extractable and corroborated. Which source a model
      selects for a given prompt is not a setting anyone can buy.
---

**The crawler that decides whether ChatGPT can cite you is `OAI-SearchBot`, not `GPTBot`.** A great deal of published advice conflates the two, and sites block the wrong one.

Getting this backwards has a specific cost: you intend to opt out of AI training, and you accidentally opt out of being recommended to buyers.

## The four OpenAI crawlers, and what each one governs

Per [OpenAI's own crawler documentation](https://developers.openai.com/api/docs/bots):

| Crawler | What it governs |
|---|---|
| `OAI-SearchBot` | Search. It surfaces websites in ChatGPT's search features. This is the citation crawler. |
| `GPTBot` | Training. Disallowing it indicates your content should not be used to train OpenAI's foundation models. |
| `ChatGPT-User` | A fetch triggered when a person asks ChatGPT to look at something. Not automatic crawling. |
| `OAI-AdsBot` | Only visits pages submitted as ads. |

The documentation is explicit that "each setting is independent of the others". So the common position, that you want to be found but not used as training data, is a supported configuration: allow `OAI-SearchBot`, disallow `GPTBot`.

One honest caveat, because the distinction is often sold as cleaner than it is. OpenAI does not state that `OAI-SearchBot` content is excluded from training. It notes that where both are allowed, results from one crawl may serve both purposes. The settings are independent permissions, not a guaranteed wall.

## Step one: check what you are actually blocking

Open `yourdomain.com/robots.txt` and look for the two user agents by name.

The failure mode is a blanket rule. A site that blocked "AI bots" in 2024 usually blocked `GPTBot`, because that was the only one that existed at the time. `OAI-SearchBot` launched later. If your robots.txt has no rule naming it, check whether a wildcard `Disallow` is catching it.

A reasonable configuration looks like this:

```
User-agent: OAI-SearchBot
Allow: /

User-agent: GPTBot
Disallow: /
```

That says: cite me, do not train on me. Whether you want the second line is a licensing decision, not a visibility one, and it is yours to make.

## Step two: be extractable once you are reachable

Access only gets the page read. What gets it quoted is the same structure that serves any answer engine:

1. The answer in the first paragraph, before the context and the positioning.
2. Headings phrased as the question a person would actually ask.
3. Specific, checkable claims. A figure with a source attached is quotable in a way that an adjective is not.
4. A named author with a stated reason to know.

This is ordinary [Answer Engine Optimisation](/blog/what-is-aeo) rather than anything ChatGPT-specific, which is the point. Google's position is that optimising for generative search is still SEO, and the same holds here.

## Step three: be corroborated somewhere else

A model assembling an answer about your company weighs whether independent sources agree. One website asserting something about itself is the weakest possible evidence, however well marked up.

This is why community platforms matter out of proportion to their traffic. In [Ahrefs' September 2026 analysis](https://ahrefs.com/blog/most-cited-domains-ai-overviews/) YouTube led on a 22.9% mention share and Quora was sixth on 4.7%, each measured against the combined citations of the top 50 sources. The pattern is that places where identifiable people answer questions get quoted heavily. We cover the Quora side of that in [why Quora answers get cited by AI search engines](/blog/quora-ai-citations).

Off-site corroboration is the slow part and usually the real constraint. It is the bulk of what our [AI Search Visibility service](/services/ai-search-visibility) actually does.

## What you cannot control

You can make a page reachable, extractable and corroborated. You cannot make a model choose it.

There is no submission endpoint, no priority tier and no paid inclusion for organic citations. Answers vary between sessions for the same prompt, which also means a single screenshot of ChatGPT naming your competitor is not a measurement of anything.

Anyone selling guaranteed ChatGPT citations is selling something that does not exist.
