// Shared static OG image used across the site for now.
// app/[lang]/docs/[[...slug]]/page.tsx when ready.
export const staticOgImage = "https://ztwjwi3ssdvgx15d.public.blob.vercel-storage.com/og-image.jpg";

// Docs pages with a dedicated OG image, keyed by page slug. Paths are served
// from `public/` and resolve against the site's `metadataBase`.
const docsOgImages: Record<string, string> = {
  "use-cases": "/og/docs-use-cases.png",
};

/** Returns the OG image for a docs page, falling back to the shared image. */
export const docsOgImage = (slugs: readonly string[]): string =>
  docsOgImages[slugs.join("/")] ?? staticOgImage;
