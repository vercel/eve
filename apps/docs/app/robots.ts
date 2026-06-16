import type { MetadataRoute } from "next";

/**
 * Tell crawlers to leave the docs site alone for now.
 *
 * Eve is pre-1.0 and the docs surface is still evolving; we don't want
 * the early site indexed by search engines and then ranking stale
 * answers as the framework keeps moving. Once we're ready to invite
 * traffic this file flips back to `allow: "/"` and the
 * `<meta name="robots">` directive in `app/[lang]/layout.tsx` flips to
 * `index: true, follow: true`.
 *
 * `disallow: "/"` here is paired with:
 * - `metadata.robots = { index: false, follow: false }` in the root
 *   layout, which renders `<meta name="robots" content="noindex,
 *   nofollow">` into every page.
 * - An `X-Robots-Tag: noindex, nofollow` HTTP header set in
 *   `next.config.ts` so non-HTML responses (rss feeds, llms.txt, etc.)
 *   are also covered.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
