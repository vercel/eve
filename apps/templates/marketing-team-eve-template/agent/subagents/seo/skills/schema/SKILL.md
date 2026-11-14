---
description: "Use when adding, fixing, or reviewing structured data: JSON-LD for articles, products, FAQs, breadcrumbs, organizations, and local businesses, and what to do when markup doesn't earn a rich result."
---

# Schema markup

Structured data tells a search engine what a page is rather than making it rank. Done right it earns a richer result and makes the page easier for an engine to summarize. Done wrong it earns a manual action.

Four rules govern everything below:

- Mark up only what the page visibly shows. Schema describing content a reader can't see is a spam signal, and it's the single most common reason markup gets penalized rather than ignored.
- Use JSON-LD, in a `<script type="application/ld+json">` in the head or at the end of the body. Google recommends it, and it's the only format you can add without touching the page's markup.
- Only claim types and properties the engine actually supports for a rich result. Valid schema.org markup with no supported result does nothing for search, which is fine, but don't promise a rich result it can't produce.
- Validate before it ships, then watch Search Console. Markup that validates can still be wrong about the page.

## Choosing the type

| Type | Use on | Required |
| --- | --- | --- |
| Organization | Homepage, about page | `name`, `url` |
| WebSite | Homepage, to declare a site search | `name`, `url` |
| Article, BlogPosting | Posts and news | `headline`, `image`, `datePublished`, `author` |
| Product | Product pages | `name`, `image`, `offers` |
| SoftwareApplication | App and SaaS pages | `name`, `offers` |
| FAQPage | A page with real questions and answers | `mainEntity` |
| HowTo | Step-by-step instructions | `name`, `step` |
| BreadcrumbList | Any page with breadcrumbs | `itemListElement` |
| LocalBusiness | A location page | `name`, `address` |
| Event | Events and webinars | `name`, `startDate`, `location` |

`references/schema-examples.md` has a complete, valid block for each of these plus a combined `@graph` and a Next.js pattern. `references/required-properties.json` is the same table in the form `validate_schema` reads, so adding a type means editing both.

When a page needs several types, prefer one `@graph` array over several separate script tags: entities can then reference each other by `@id` instead of repeating themselves.

## Reviewing existing markup

A fetch of the page shows only server-rendered JSON-LD. CMS SEO plugins commonly inject it client side, so absence in fetched HTML is not absence on the page. Report what the server HTML contained, then send them to the Rich Results Test, which renders JavaScript.

When markup exists but earns nothing, check in this order: a required property missing, a value in the wrong shape (dates must be ISO 8601, URLs absolute, enumerations exact), the type having no rich result to earn, or the markup describing something the page doesn't show.

Run `validate_schema` on any block before you hand it over. It parses the JSON, checks each type against the required properties in `references/required-properties.json`, and catches the two value shapes that fail most often: a date that isn't ISO 8601 and a relative URL. It's mechanical, so a clean result means the syntax is right and nothing more.

Then point the user at the Rich Results Test at https://search.google.com/test/rich-results for eligibility, and the schema.org validator at https://validator.schema.org/ for correctness against the vocabulary. Those answer different questions from each other and from the tool, so a block can pass one and fail another. None of the three can tell you whether the markup describes what the page actually shows, which is the accuracy rule above and still yours to check.

## Handing it over

Give the complete block, ready to paste, with the page's real values filled in rather than placeholders. Say where it goes, name any property you had to leave out and why, and note which rich result it makes the page eligible for, with eligible being the honest word. Google decides whether to show one.

## Sources

- Google Search Central, Intro to how structured data works: https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data
- Google Search Central, Structured data general guidelines: https://developers.google.com/search/docs/appearance/structured-data/sd-policies
- Google Search Central, Search gallery of supported result types: https://developers.google.com/search/docs/appearance/structured-data/search-gallery
- schema.org: https://schema.org/
