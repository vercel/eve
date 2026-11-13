---
description: "Use when planning or restructuring what pages a site has and how they connect: hierarchy, navigation, URL patterns, breadcrumbs, and internal linking. Not for XML sitemaps, which are in seo-audit."
---

# Site architecture

Architecture is one decision repeated: how does someone get from the homepage to the page that answers their question, and how does a crawler follow the same path. Depth, navigation, URLs, and internal links are four views of that one structure, so change them together or they drift.

## Depth

Aim to put any page that matters within three clicks of the homepage. It isn't a law, but a critical page four or more levels down is a symptom worth chasing.

| Shape | Fits | Costs |
| --- | --- | --- |
| Flat, 2 levels | Small sites, portfolios | Stops scaling once a nav item has 20 children |
| Moderate, 3 levels | Most SaaS and content sites | Usually the right answer |
| Deep, 4 or more | Large catalogs, big docs | Scales, but buries things without strong linking |

Go as flat as the navigation tolerates. When a dropdown passes roughly 20 items, that's the signal to add a level rather than keep the list flat.

Levels: L0 is the homepage, L1 is a primary section (`/features`, `/blog`), L2 is a page within it (`/features/analytics`), L3 and beyond are detail pages (`/docs/api/authentication`).

## Site types as starting points

| Type | Depth | Sections | URL shape |
| --- | --- | --- | --- |
| SaaS marketing | 2 to 3 | Home, Features, Pricing, Blog, Docs | `/features/{name}`, `/blog/{slug}` |
| Content site | 2 to 3 | Home, Blog, Categories, About | `/blog/{slug}`, `/blog/category/{slug}` |
| Ecommerce | 3 to 4 | Home, Categories, Products | `/{category}/{subcategory}/{product}` |
| Documentation | 3 to 4 | Home, Guides, Reference | `/docs/{section}/{page}` |
| SaaS plus content | 3 to 4 | Home, Product, Blog, Resources, Docs | `/product/{feature}`, `/blog/{slug}` |
| Small business | 1 to 2 | Home, Services, About, Contact | `/services/{name}` |

## URLs

Readable, lowercase, hyphenated, mirroring the hierarchy, with one trailing-slash policy enforced everywhere. Short but still descriptive: `/blog/landing-page-conversions` beats `/blog/how-to-improve-your-landing-page-conversion-rates`.

The mistakes that cost the most:

- Dates in blog URLs. `/blog/2026/07/25/title` adds nothing and ages the post visibly.
- IDs or query strings carrying content. `/product/12345` and `/blog?id=123` should be slugs.
- Over-nesting past what the hierarchy needs.
- Mixing parents for the same kind of page, like `/features/analytics` alongside `/product/automation`.
- Changing a URL without a 301. Every old URL needs one, or the links pointing at it stop counting and anyone who bookmarked it gets a 404. This is the single most common cause of traffic loss after a redesign.

`references/patterns.md` has the URL pattern per page type, navigation layouts, and the diagram formats to hand back.

## Navigation

Primary navigation holds 4 to 7 items, ordered by importance, with the logo linking home and the call to action rightmost. Past 7, people stop reading the list and start hunting.

Footers group into columns: product, resources, company, legal. Sidebars carry within-section navigation for docs and long content. Breadcrumbs mirror the URL path exactly, with every segment linked except the current page, and they pair with `BreadcrumbList` schema.

Breadcrumbs are the cheapest structural win available: they add internal links on every page, they make hierarchy legible to a crawler, and they can earn a richer result.

## Internal linking

- No orphans. Every page needs at least one internal link pointing at it, and the sitemap is not a link.
- Anchor text describes the destination. Never "click here" or "read more".
- How many contextual links a single page carries is a decision for whoever owns that page's format, so recommend the connections worth making rather than a density target.
- Link the pages that matter more often. Inbound internal links are how you tell a crawler what's important.
- Hub and spoke for content clusters: one comprehensive hub, spokes covering sub-topics, each spoke linking back to the hub, the hub linking to all spokes, and spokes cross-linking where a reader would actually want it.

Hub and spoke is what makes a set of posts add up to more than its pages, because it concentrates the signal on the hub rather than spreading it across a dozen equal posts competing with each other.

## What to hand back

An ASCII tree of the hierarchy with the URL at each node, a URL map table (page, URL, parent, where it appears in navigation, priority), the redirect list when anything moves, and a Mermaid diagram when the structure is worth seeing rather than reading. `references/patterns.md` has the formats.

## Sources

- Google Search Central, URL structure best practices: https://developers.google.com/search/docs/crawling-indexing/url-structure
- Google Search Central, Redirects and Google Search: https://developers.google.com/search/docs/crawling-indexing/301-redirects
- Google Search Central, Breadcrumb structured data: https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
- Nielsen Norman Group, Flat vs deep website hierarchies: https://www.nngroup.com/articles/flat-vs-deep-hierarchy/
