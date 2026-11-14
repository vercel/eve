---
description: "Use when reviewing a page or site for organic search, or diagnosing why something isn't ranking: crawl and index signals, on-page elements, content quality, and how to order the fixes."
---

# SEO audit

Audit in priority order, because the layers depend on each other. A page that can't be indexed doesn't benefit from a better title.

1. Can it be found and indexed? Robots rules, canonical tags, noindex, redirect chains.
2. Is the foundation sound? HTTPS, mobile rendering, speed, URL structure.
3. Is the page optimized? Title, meta description, headings, keyword alignment, internal links, images.
4. Does it deserve to rank? Depth, first-hand experience, sourcing, whether it beats what already ranks.
5. Does it have credibility? Who links to it, who cites it.

Work down the list and stop where the evidence stops. Most asks are answered at layers 3 and 4.

## What a fetch can and can't tell you

`web_fetch` returns the server's HTML as text. Everything you report as observed has to come from that, from a source you read, or from the caller.

Readable from a fetch: title tag, meta description, heading order and text, body copy, visible links and their anchor text, canonical tag, `robots` meta, `hreflang` in the HTML head, server-rendered JSON-LD, `robots.txt` and `sitemap.xml` when you fetch them directly.

Not readable, so not yours to assert: anything JavaScript injects after load, Core Web Vitals and any speed measurement, whether Google has actually indexed a URL, rank position, search volume, traffic, backlink counts, and whole-site facts like orphan pages or crawl budget that need a crawl you can't run.

The trap worth naming: CMS SEO plugins commonly inject JSON-LD client side, so a fetch shows no schema on a page that has plenty. Never conclude "no schema" from a fetch. Report that the server HTML carried none, and send them to the Rich Results Test at https://search.google.com/test/rich-results, which renders JavaScript.

For a check you can't run, name the check and the tool rather than skipping it silently. Search Console covers index coverage and queries; PageSpeed Insights covers Core Web Vitals; a crawler like Screaming Frog covers site-wide structure.

## Diagnosing a page that isn't ranking

Work outward from the page before reaching for site-wide theories.

- Does the page target one query, and do the title, H1, URL, and opening paragraph agree on which one? Disagreement here explains more ranking problems than anything technical.
- Is another page on the site competing for the same query? Two mediocre pages on one keyword lose to one good one, and the fix is usually to merge them and redirect.
- Is the intent right? A product page will not rank for a question query however well optimized it is.
- Is it thinner than what ranks? Compare against the pages currently ranking rather than against a word count.
- Did something change? A migration, a redesign, or a template change dated near the drop is the first thing to check, and a drop that starts on a single date usually has a single cause.

## References

- `references/audit-checklist.md`: the per-area checks, each marked with whether a fetch can verify it.
- `references/international-seo.md`: hreflang, canonical interaction, and locale URL structure for multi-language sites, with the errors that silently void a whole cluster.

## Reporting

Give each finding the problem, why it matters for search, the evidence, the fix, and its rank against the others. Open with the few things worth doing first, and close with what you couldn't check and what it would take. Group by layer, not by page, so someone can fix a class of problem once.
