---
title: "How Google AI Overviews choose which sources to cite"
seoTitle: "How Google AI Overviews Choose Sources | Vaeral"
slug: google-ai-overviews
date: 2026-10-21
description: More than a third of pages cited in AI Overviews do not rank in the top 100. What decides source selection, and which Google control actually governs it.
coverImage: /assets/blog-reddit-marketing.jpg
draft: false
tags:
  - Google AI Overviews
  - AI Search
  - AEO
faqs:
  - question: Do AI Overviews only cite pages that rank well?
    answer: No. In Ahrefs' March 2026 study of 863,000 search results pages, 37.1%
      of cited URLs ranked in the organic top ten, 26.2% ranked between 11 and
      100, and 36.7% did not rank in the top 100 at all.
  - question: Does blocking Google-Extended remove my site from AI Overviews?
    answer: No, and this is the most common mistake. Google's documentation points
      to robots.txt directives for Googlebot as the control for these features,
      and describes Google-Extended as limiting AI training and grounding in
      some of Google's other systems. AI Overviews are served from the Googlebot
      index.
  - question: How do I stop my content appearing in an AI Overview?
    answer: There is no AI-specific opt-out file. Google directs site owners to the
      standard preview controls, nosnippet, data-nosnippet and max-snippet, to
      limit what is shown from a page, and to noindex to remove the page from
      Search entirely. Blocking the preview also removes ordinary snippets.
  - question: Do I need an llms.txt or other AI file to appear?
    answer: No. Google's guidance states you do not need to create new machine
      readable files, AI text files or markup to appear in these features.
  - question: Can I measure AI Overview appearances in Search Console?
    answer: Partially. Google includes these features in the Search Console
      Performance report under the Web search type, so impressions and clicks
      are counted there. They are not broken out as a separate dimension, so you
      cannot isolate AI Overview performance from ordinary results.
---

**More than a third of the pages cited in Google AI Overviews do not rank in the top 100 for the query they are cited on.** Source selection and ranking have come apart, and that changes what is worth doing about it.

## What the citation distribution actually looks like

[Ahrefs analysed 863,000 search results pages and four million AI Overview URLs in March 2026](https://ahrefs.com/blog/ai-overview-citations-top-10), comparing each cited URL against the organic results for the same query. Of the pages cited, 37.1% ranked in the organic top ten, 26.2% ranked somewhere between 11 and 100, and 36.7% did not rank in the top 100 at all, against a top-ten figure of 76% in its previous analysis.

The link between ranking and being quoted has weakened considerably in about a year.

Two readings follow, and both matter. Holding position three no longer reserves you a place in the answer above it. And a page that ranks nowhere can still be quoted, which is the opening for sites that cannot realistically outrank an incumbent.

## Which domains get cited

[Ahrefs' September 2026 ranking of the most-cited domains](https://ahrefs.com/blog/most-cited-domains-ai-overviews/), across more than three million US queries, is topped by YouTube on a 22.9% mention share, with Quora sixth on 4.7%. Ahrefs measures mention share against the combined citations of the top 50 sources, not against every citation.

The pattern is that platforms where identifiable people answer questions are quoted out of all proportion to a single company website. That is partly a format effect and partly a corroboration effect, and we cover the Quora case in [why Quora answers get cited by AI search engines](/blog/quora-ai-citations).

## The control most sites get wrong

If you want to limit how your content is used, the important thing is to block the right agent. Two are routinely confused, and the consequences run in opposite directions.

Per [Google's documentation on AI features in Search](https://developers.google.com/search/docs/appearance/ai-features), "robots.txt directives for Googlebot is the control for site owners to manage access" to these features. `Google-Extended` is described separately, as the way "to limit AI training and grounding in some of Google's other systems".

So:

- **`Googlebot`** governs whether you can appear in Search at all, AI Overviews included. Block it and you leave Search.
- **`Google-Extended`** governs training and grounding in Google's other AI systems. Blocking it does **not** remove you from AI Overviews.

A site that blocked `Google-Extended` believing it had opted out of AI Overviews has opted out of something else entirely, while remaining fully eligible for the feature it meant to leave. This is the same class of error as [blocking GPTBot and expecting to disappear from ChatGPT](/blog/how-to-get-cited-by-chatgpt), where the citation crawler is a different agent again.

## If you genuinely want out

There is no AI-specific opt-out file. Google directs site owners to the ordinary preview controls: `nosnippet`, `data-nosnippet` and `max-snippet` limit what can be shown from a page, and `noindex` removes it from Search.

The catch is that these are not AI-specific either. Suppressing the preview suppresses your ordinary search snippet along with it. For most commercial sites that trade is worse than the thing it prevents.

## What you do not need

Google's guidance is explicit that "you don't need to create new machine readable files, AI text files, or markup to appear in these features". A missing `llms.txt` is not the reason you are not being cited, whatever an audit told you. The broader version of this argument is in [what is Answer Engine Optimisation](/blog/what-is-aeo).

## What actually moves it

Since ranking explains well under half of citations, the levers that remain are the unglamorous ones: a direct answer placed where it can be extracted, claims specific enough to be worth quoting, and independent sources that corroborate what your own site says about you.

The third is the slow one and usually the binding constraint. It is most of what our [AI Search Visibility service](/services/ai-search-visibility) does, and it is why the work looks more like reputation building than like technical SEO.
