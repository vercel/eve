# Audit checklist

Per-area checks in priority order. The Evidence column says what it takes to verify the check honestly: `fetch` means a single `web_fetch` of the page or file is enough, `tool` means it needs access you don't have, so name it as unchecked rather than asserting it.

## 1. Crawl and index

| Check | Evidence |
| --- | --- |
| `robots.txt` exists and doesn't block anything important | fetch |
| `robots.txt` references the sitemap | fetch |
| `sitemap.xml` exists, parses, and lists canonical indexable URLs only | fetch |
| Sitemap has no redirected, 404, or noindexed URLs in it | fetch |
| Page has a canonical tag, self-referencing when the page is the original | fetch |
| No `noindex` on a page that should rank | fetch |
| One canonical host (www or not, http or https) with the others redirecting | fetch |
| Trailing-slash handling is consistent | fetch |
| No redirect chains or loops on key paths | fetch |
| The URL is actually indexed | tool: Search Console |
| Indexed count matches expected count | tool: Search Console |
| Crawl budget, faceted-navigation explosion, parameter duplication | tool: crawler |
| Orphan pages across the site | tool: crawler |

Soft 404s and near-duplicate clusters need Search Console. A page that returns 200 with no real content is visible from a fetch, so call that out directly.

## 2. Foundations

| Check | Evidence |
| --- | --- |
| HTTPS everywhere, valid certificate, no mixed content | fetch |
| Viewport meta present, layout not fixed-width | fetch |
| URLs readable, lowercase, hyphenated, no session IDs or content in query strings | fetch |
| Largest Contentful Paint under 2.5s | tool: PageSpeed Insights |
| Interaction to Next Paint under 200ms | tool: PageSpeed Insights |
| Cumulative Layout Shift under 0.1 | tool: PageSpeed Insights |
| Server response time, caching headers, CDN, font loading | tool: PageSpeed Insights or WebPageTest |

Page weight and blocking scripts are partly visible in fetched HTML: a head full of synchronous third-party scripts is worth flagging as a likely speed problem, framed as a hypothesis for them to confirm.

## 3. On-page

| Check | Target |
| --- | --- |
| Title tag | Unique per page, primary keyword near the front, roughly 50 to 60 characters, brand at the end if included |
| Meta description | Unique, roughly 150 characters or under since mobile truncates near 120, states the value and earns the click. Not a ranking factor |
| H1 | Exactly one, describes the page, contains the target query or its clear paraphrase |
| Heading order | H1 then H2 then H3 with no skipped levels, subheads readable as a map of the page |
| Target query | Appears in the first 100 words, naturally, along with the phrasings a reader would actually use |
| Keyword alignment | Title, H1, URL, and opening all point at the same query |
| Cannibalization | No other page on the site targets the same query |
| Internal links | Descriptive anchor text, no "click here", important pages linked more often, no broken links |
| Images | Descriptive filenames, alt text that describes the image, compressed, modern format, lazy loaded below the fold |

All of the above are fetch-verifiable except cannibalization, which needs either a site-wide crawl or the caller telling you what else exists. Ask.

## 4. Content quality

Judge against the pages currently ranking for the query, not against a word count. Google is explicit that word count is not a ranking factor.

- Experience: does it show first-hand use, original data, or real examples, or does it read assembled from other pages?
- Expertise: is the author named and credentialed where that matters, and are claims sourced?
- Trust: is there a real business behind it, contact details, a privacy policy, and no contradiction between what the page claims and what it shows?
- Depth: does it answer the obvious follow-up question, or stop at the headline answer?
- Currency: is anything dated, superseded, or describing a product that has changed?
- Thin pages: tag and category pages with nothing unique, doorway pages, and pages that exist only to hold a keyword.

## 5. Authority

Off-page work needs a backlink tool, so treat this as scoping rather than measurement: name whether the page has any obvious reason to be linked or cited, and what asset would earn links if it doesn't. Do not estimate a domain metric you cannot read.

## Common patterns by site type

- SaaS: thin feature pages, blog disconnected from product pages, missing comparison and alternative pages, no glossary.
- Ecommerce: thin category pages, duplicated manufacturer descriptions, missing product schema, faceted navigation generating duplicates, out-of-stock pages left to rot.
- Content sites: stale posts never refreshed, several posts competing for one query, no topic clustering, weak internal linking, missing author pages.
- Local: inconsistent name, address, and phone across pages, missing LocalBusiness schema, no location pages.
- Multi-locale: see `international-seo.md`, since the failure modes there are specific and severe.

## Sources

- Google Search Central, Search Essentials: https://developers.google.com/search/docs/essentials
- Google Search Central, Creating helpful, reliable, people-first content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- Google Search Central, Robots.txt introduction: https://developers.google.com/search/docs/crawling-indexing/robots/intro
- Google Search Central, Consolidate duplicate URLs: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google Search Central, Sitemaps overview: https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview
- web.dev, Core Web Vitals: https://web.dev/articles/vitals
- Google Rich Results Test: https://search.google.com/test/rich-results
