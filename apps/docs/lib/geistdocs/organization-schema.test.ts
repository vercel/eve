import { describe, expect, it } from "vitest";
import { organizationSchema, organizationSchemaJson } from "./organization-schema";

describe("organization schema", () => {
  it("publishes Vercel's minimal publisher identity as JSON-LD", () => {
    expect(organizationSchema).toEqual({
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
    });
    expect(JSON.parse(organizationSchemaJson)).toEqual(organizationSchema);
  });

  it("escapes HTML-significant characters in the inline JSON-LD payload", () => {
    expect(organizationSchemaJson).not.toContain("<");
  });
});
