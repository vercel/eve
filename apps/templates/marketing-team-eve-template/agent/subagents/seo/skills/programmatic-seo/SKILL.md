---
description: "Use when planning many similar pages from a template and a data set: choosing the pattern, deciding whether the data can carry it, and avoiding the thin-content failure that gets page sets deindexed."
---

# Programmatic SEO

Building pages from a template and a data set works when each page answers a real query with something only your data can say. It fails the same way every time: a template with the variable swapped, published at volume, on queries nobody searches. That is the definition of a doorway page, and Google's spam policies name it.

So the question to settle before any of the mechanics is whether the data is worth a page.

## Does the data carry it

Defensibility runs in this order, strongest first:

1. Proprietary, because you generated it.
2. Product-derived, from how your own users behave.
3. User-generated, from your community.
4. Licensed, where the license is exclusive.
5. Public, which anyone can use and everyone already has.

A set built on public data competes with every other set built on the same public data, so it has to win on presentation, freshness, or aggregation instead. That is possible and it is a much harder brief. Say so rather than shipping 5,000 pages that restate a public API.

Then check demand actually exists: aggregate volume across the pattern, how it splits between head and long tail, and whether the trend is going anywhere. A pattern with 10,000 combinations and no searches for 9,000 of them is a 1,000-page opportunity.

## Choosing a pattern

| You have | Consider |
| --- | --- |
| Proprietary data set | Directory, Profiles |
| A product with integrations | Integrations |
| A design or creative product | Templates, Examples |
| Several distinct audience segments | Personas |
| A local footprint | Locations |
| A utility or calculator | Conversions |
| Deep subject expertise | Glossary, Curation |
| A crowded competitive field | Comparisons |

`references/playbooks.md` covers the twelve patterns, each with its query shape, what data it needs, and how it usually fails.

Patterns layer, and layering is often where the real opportunity is: "best coworking spaces in Austin" is Curation crossed with Locations.

## Making each page worth indexing

- Every page needs something specific to it beyond the substituted variable: a number, a comparison, a list, an image, a genuine answer.
- Write the introduction per page, or generate it from enough fields that no two read alike. A shared paragraph with one word swapped is the tell.
- Vary structure by what the data supports. A page with three data points shouldn't use the layout built for thirty; branch the template instead of padding.
- Give each page a unique title and meta description built from its variables, not one pattern with the variable appended.
- Match the query's intent. A comparison query wants a comparison, not a signup page.

## Structure and indexation

- Subfolders, not subdomains, so the pages build authority on the same domain rather than splitting it.
- Hub and spoke: a category page linking to every page in the set, each page linking back, and related pages cross-linking. Otherwise the set is orphaned and only the sitemap points at it.
- Own sitemap for the set, or a sitemap per pattern, so indexing rates per pattern are readable.
- Ship the strongest slice first rather than the whole set. Publish the highest-demand pages, confirm they get indexed and ranked, then expand. A set that goes out all at once gives no signal about which part worked.
- Leave the thinnest variations out entirely. That is better than publishing them and noindexing them later, since crawl spent on pages you didn't want is crawl not spent on pages you did.

## Before it ships

Check that each page has unique value and answers its query, that titles and descriptions are unique, that heading structure and schema are in place, that the set is linked from the site rather than only the sitemap, that no page has a conflicting noindex, and that nothing in the set competes with an existing page for the same query.

After launch, watch what fraction of the set gets indexed, which patterns rank, and whether engagement holds up. Thin-content warnings, a drop across the set, or an indexing rate that stalls well below 100% all mean the same thing: cut, don't add.

## What this hands off

Programmatic SEO decides the pattern, the data, the URL shape, the template's sections, and the linking. The words inside a template section are copy: hand the content marketer the template, the target query, and the fields available per page.

## Sources

- Google Search Central, Spam policies: https://developers.google.com/search/docs/essentials/spam-policies
- Google Search Central, Creating helpful, reliable, people-first content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- Google Search Central, Sitemaps overview: https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview
