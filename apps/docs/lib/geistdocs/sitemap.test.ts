import { describe, expect, it } from "vitest";
import { createCanonicalSitemap } from "./sitemap";

const sourceDate = new Date("2026-07-20T12:00:00.000Z");

const sources = [
  { pathname: "/" },
  { pathname: "/docs/getting-started", lastModified: sourceDate },
  { pathname: "/docs/getting-started", lastModified: new Date("2026-08-01") },
  { pathname: "/integrations" },
  { pathname: "/integrations/slack" },
  { pathname: "/templates" },
  { pathname: "/templates/eve-chat-template" },
  { pathname: "/docs/channels" },
  { pathname: "/docs/getting-started.md" },
  { pathname: "/integrations?filter=channel" },
  { pathname: "/en/integrations/slack" },
  { pathname: "/llms.txt" },
  { pathname: "/api" },
  { pathname: "/unknown.xml" },
];

describe("createCanonicalSitemap", () => {
  it("includes each canonical public HTML route exactly once", () => {
    const sitemap = createCanonicalSitemap({
      excludedPathnames: ["/docs/channels"],
      origin: "https://eve.dev",
      sources,
    });

    expect(sitemap.map(({ url }) => url)).toEqual([
      "https://eve.dev/",
      "https://eve.dev/docs/getting-started",
      "https://eve.dev/integrations",
      "https://eve.dev/integrations/slack",
      "https://eve.dev/templates",
      "https://eve.dev/templates/eve-chat-template",
    ]);
  });

  it("excludes redirects, queries, locale aliases, machine routes, and errors", () => {
    const urls = createCanonicalSitemap({
      excludedPathnames: ["/docs/channels"],
      origin: "https://eve.dev",
      sources,
    }).map(({ url }) => url);

    expect(urls).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("?"),
        expect.stringContaining("/en/"),
        expect.stringMatching(/\.(?:md|mdx|txt|xml)$/),
        "https://eve.dev/docs/channels",
        "https://eve.dev/api",
      ]),
    );
  });

  it("uses trustworthy source dates without build-time fallbacks", () => {
    const first = createCanonicalSitemap({ origin: "https://eve.dev", sources });
    const second = createCanonicalSitemap({ origin: "https://eve.dev", sources });
    const docsEntry = first.find(({ url }) => url.endsWith("/docs/getting-started"));
    const integrationEntry = first.find(({ url }) => url.endsWith("/integrations/slack"));

    expect(docsEntry?.lastModified).toEqual(sourceDate);
    expect(docsEntry?.lastModified).not.toBe(sourceDate);
    expect(integrationEntry).not.toHaveProperty("lastModified");
    expect(second).toEqual(first);
  });

  it("omits invalid source dates", () => {
    expect(
      createCanonicalSitemap({
        origin: "https://eve.dev",
        sources: [{ pathname: "/docs/getting-started", lastModified: new Date("invalid") }],
      }),
    ).toEqual([{ url: "https://eve.dev/docs/getting-started" }]);
  });
});
