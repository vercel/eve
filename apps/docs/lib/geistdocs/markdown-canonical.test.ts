import { describe, expect, it } from "vitest";
import { applyMarkdownRouteCanonical, removeProxyMarkdownCanonical } from "./markdown-canonical";

describe("Markdown canonical ownership", () => {
  it("removes proxy canonicals from Markdown rewrites", () => {
    const response = new Response(null, {
      headers: {
        link: '<https://eve.dev/docs/getting-started>; rel="canonical"',
        "x-middleware-rewrite": "https://eve.dev/en/llms.mdx/getting-started",
      },
    });

    removeProxyMarkdownCanonical(response);

    expect(response.headers.get("link")).toBeNull();
  });

  it("keeps canonicals on unrelated proxy responses", () => {
    const canonical = '<https://eve.dev/docs/getting-started>; rel="canonical"';
    const response = new Response(null, {
      headers: {
        link: canonical,
        "x-middleware-rewrite": "https://eve.dev/en/docs/getting-started",
      },
    });

    removeProxyMarkdownCanonical(response);

    expect(response.headers.get("link")).toBe(canonical);
  });

  it("adds one canonical for an existing Markdown page", () => {
    const response = new Response("# Getting Started", {
      headers: { "content-type": "text/markdown" },
    });

    applyMarkdownRouteCanonical(response, "https://eve.dev/docs/getting-started");

    expect(response.headers.get("link")).toBe(
      '<https://eve.dev/docs/getting-started>; rel="canonical"',
    );
  });

  it("removes canonicals from useful not-found responses without changing their status", () => {
    const response = new Response("# Page Not Found", {
      status: 200,
      headers: {
        link: '</docs/installtion>; rel="canonical"',
        "x-geistdocs-not-found": "1",
        "x-robots-tag": "noindex",
      },
    });

    applyMarkdownRouteCanonical(response, "https://eve.dev/docs/installtion");

    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });
});
