---
title: "How to track whether AI engines mention your brand"
seoTitle: "How to Track Brand Mentions in AI Search | Vaeral"
slug: track-brand-mentions-ai-search
date: 2026-10-21
description: There is no native dashboard for AI citations and the attribution is poor. What you can measure honestly, and what no tool can currently tell you.
coverImage: /assets/blog-reddit-marketing.jpg
draft: false
tags:
  - AI Search
  - Measurement
  - AEO
faqs:
  - question: Is there a dashboard for AI search citations?
    answer: No native one. Google includes its AI features in the Search Console
      Performance report under the Web search type, but does not break them out
      as a separate dimension, so AI appearances cannot be isolated from
      ordinary results. ChatGPT and Perplexity publish no equivalent report at
      all.
  - question: Can I see traffic from ChatGPT in Google Analytics?
    answer: Partly. Sessions that arrive through a clicked link carry a referrer
      such as chatgpt.com or perplexity.ai, so they appear as referral traffic.
      What this misses is every answer where the user read about you and never
      clicked, which is the majority.
  - question: Why do I get a different answer each time I ask the same question?
    answer: Because model outputs vary between sessions, and answers are also
      personalised and time-sensitive. This is why a single screenshot of an AI
      naming a competitor is not a measurement. Only repeated, logged prompts
      across time show a pattern.
  - question: How many prompts do I need to test?
    answer: Enough to see a rate rather than an incident. A workable starting point
      is twenty to thirty prompts a buyer would plausibly type, each run on a
      fixed schedule and logged, so you are comparing the same questions month
      to month.
  - question: Can anyone guarantee a brand appears in AI answers?
    answer: No. Source selection is not a setting, there is no paid inclusion for
      organic citations, and answers vary by session. Treat a guarantee as a
      reason to walk away.
---

**There is no native dashboard for AI search citations, and the attribution is worse than anything you are used to in SEO.** Most of the value of being cited is invisible to analytics, because the person reads the answer and never clicks.

That is the honest starting position. What follows is what can still be measured.

## What Search Console does and does not give you

Google includes its AI features in Search Console reporting. Per [Google's documentation](https://developers.google.com/search/docs/appearance/ai-features), these features are counted in the Performance report under the "Web" search type.

What you do not get is a breakdown. There is no dimension that isolates AI appearances from ordinary blue-link results, so an impression that came from an AI Overview is mixed in with everything else. You can see your total, you cannot attribute it.

For ChatGPT and Perplexity there is no publisher reporting at all.

## The three things you can actually measure

**1. Referral sessions.** Sessions arriving from a clicked citation carry a referrer. In Google Analytics, segment by source for `chatgpt.com`, `perplexity.ai`, `copilot.microsoft.com` and `gemini.google.com`.

This number will look small. Read it as a floor, not a total: it counts only the people who clicked, and the normal outcome of a good citation is that the reader got their answer and left satisfied.

Engagement rate on this traffic is worth watching separately. It is often higher than other channels, because the person arrives pre-qualified by the answer they just read.

**2. Prompt testing, logged over time.** Write down twenty to thirty questions a buyer would actually type. Not your keywords, the questions: "who handles negative reviews for app companies in India", "best way to deal with a bad Reddit thread about my brand".

Run them on a fixed schedule. Record for each: were you mentioned, were you cited with a link, which page, and who else appeared.

The discipline that makes this worth doing is running the same prompts every time. A one-off check tells you nothing, because answers vary between sessions. A rate across thirty prompts repeated monthly is a signal.

**3. Which page gets cited.** When you are cited, note the URL. This is the most actionable number in the whole exercise, because it tells you which of your pages is extractable and which is not, and often the answer is not the page you would have guessed.

## What no tool can tell you

Be clear about the ceiling before you buy anything.

- **Impressions inside an answer.** Nobody reports how many people saw an answer that mentioned you without clicking.
- **Causation.** You cannot show that a citation produced a sale. You can show a correlation across a long enough window, which is not the same thing.
- **A stable ranking.** There is no position to hold. The same prompt can return different sources an hour apart.

Several vendors sell "AI visibility tracking". What they are doing is the prompt testing described above, automated and at scale. That is genuinely useful and worth paying for if the volume justifies it. It is not privileged access to anything, and no vendor has a feed from OpenAI or Google.

## How to read the numbers without fooling yourself

Expect small, noisy figures for a long time. A brand with modest search demand may see a handful of AI referrals a month, and that can still be the most qualified traffic it gets.

Two failure modes to avoid. The first is treating a single bad answer as a crisis, when it may not reproduce on the next run. The second is treating a single good answer as proof the programme is working, for the same reason. Both are sampling errors dressed up as insight.

If the answers about you are wrong rather than absent, that is a different problem with a different fix, closer to [brand search result management](/services/brand-search-results) than to measurement.

## Where the effort actually goes

Measurement tells you where you stand. It does not move anything.

What moves citations is being extractable and being corroborated, and the second is the slow part: independent sources that say the same thing about you as your own site does. The mechanics are in [what is Answer Engine Optimisation](/blog/what-is-aeo), and the platform-specific versions in [how to get cited by ChatGPT](/blog/how-to-get-cited-by-chatgpt) and [how Google AI Overviews choose sources](/blog/google-ai-overviews).

If you would rather have this run for you than build it, that is what our [AI Search Visibility service](/services/ai-search-visibility) covers.
