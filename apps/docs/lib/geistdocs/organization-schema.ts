export const organizationSchema = {
  "@context": "https://schema.org",
  "@id": "https://eve.dev/#publisher",
  "@type": "Organization",
  name: "Vercel",
  sameAs: [
    "https://en.wikipedia.org/wiki/Vercel",
    "https://www.wikidata.org/wiki/Q56069184",
    "https://github.com/vercel",
    "https://x.com/vercel",
  ],
  url: "https://vercel.com",
} as const;

export const organizationSchemaJson = JSON.stringify(organizationSchema).replace(/</g, "\\u003c");
