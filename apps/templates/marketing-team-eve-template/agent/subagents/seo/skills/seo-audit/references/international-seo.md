# International SEO

For sites serving several languages or regions. The failure modes here are unusually severe: a single missing annotation can void a whole locale cluster, and thin locale pages drag on site-wide quality rather than just their own rankings. Most of this is fetch-verifiable, since hreflang and canonical tags are in the served HTML.

## Hreflang

Three placements are equivalent: a `<link>` in the head, an HTTP `Link` header, or `<xhtml:link>` in the sitemap. Pick one. If you use more than one and they disagree, the conflicting pair gets dropped. Past roughly ten locales, prefer the sitemap: it costs no page weight and no per-request work.

What has to be true:

- Every page includes a self-referencing entry. Without it, all hreflang on the page is ignored.
- Links are reciprocal. If A points to B, B points back to A, or the pair is discarded.
- Codes are ISO 639-1 language plus optional ISO 3166-1 alpha-2 region: `en`, `en-GB`. Never `en-UK`.
- `x-default` is present and points at the fallback, either a language selector or the default locale.
- Every target returns 200, is indexable, and matches its own canonical.
- No duplicate language-region code points at two different URLs.

The five errors worth checking first, because each is silent: a missing self-reference, a one-directional pair, an invalid code like `en-UK`, a target that is non-canonical or 404 or blocked, and HTML annotations that disagree with the sitemap.

At scale, `<xhtml:link>` children don't count toward the 50,000-URL sitemap limit, but the 50 MB file limit becomes the binding constraint, so plan 2,000 to 5,000 URLs per file once every entry carries full hreflang. Hreflang is not required on every page: concentrate it where wrong-language traffic actually lands. Bing treats hreflang as a weak signal, so supplement with `<html lang>` for it.

## Canonical interaction

This is where most multi-locale sites break, because canonical beats hreflang when the two disagree.

- Each locale page self-canonicals: `/ar/page` points at `/ar/page`.
- Never canonical across locales. Pointing French at English suppresses the French page entirely.
- The canonical URL must appear in the page's own hreflang set. If it doesn't, all hreflang on the page is ignored.
- Protocol and domain have to match across canonical, hreflang, and sitemap.
- Paginated locale pages self-canonical per page. Never point page 2 at page 1.

Common causes: a CMS canonicalizing every deep page to the homepage, a template canonicalizing all locales to English, and a protocol mismatch between canonical and hreflang.

## Locale URLs

Subdirectories (`/en/`, `/ar/`) are the recommended default. Subdomains and ccTLDs work. Query parameters (`?lang=en`) do not.

- Prefix every locale, including the default. Hiding the default locale's prefix stops Google distinguishing the versions.
- Handle the root either as `x-default` with a redirect, or as the default locale's content.
- Don't negotiate content by IP or `Accept-Language`. Googlebot crawls from US IPs and sends no `Accept-Language`, so it will only ever see one version.
- Keep trailing-slash and case consistent across paths, canonicals, hreflang, and sitemaps, and 301 the non-canonical form.

Search Console's International Targeting report is deprecated, so geotargeting now rests on hreflang, content signals, and linking patterns.

## Content across locales

- Translate the whole page, not the chrome. Google reads visible content to determine language, so translating navigation while the body stays in the source language produces duplicates.
- Machine translation is not inherently spam, but translations published at scale with no review can fall under scaled content abuse.
- Don't create a locale you can't make genuinely useful. Thin locale pages are the worst of the options: noindexing them wastes crawl budget, and cross-locale canonicalizing them conflicts with hreflang.
- Localize the details that signal a real regional presence: currency, phone format, address, date format.

## Framework note

Next.js `alternates.languages` does not add a self-referencing `<xhtml:link>` for the `<loc>` URL. Add the current locale explicitly, or every page in the set ships without its self-reference and all hreflang is ignored.

## Sources

- Google Search Central, Localized versions of your pages: https://developers.google.com/search/docs/specialty/international/localized-versions
- Google Search Central, Managing multi-regional and multilingual sites: https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites
- Google Search Central, Consolidate duplicate URLs: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google Search Central, Spam policies (scaled content abuse): https://developers.google.com/search/docs/essentials/spam-policies
- Next.js, Internationalization metadata: https://nextjs.org/docs/app/api-reference/functions/generate-metadata
