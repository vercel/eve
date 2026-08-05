import { describe, expect, it } from "vitest";
import { transformSitemapMarkdown } from "./sitemap-transform";

const transform = (markdown: string) =>
  transformSitemapMarkdown(markdown, {
    resolveTitle: (title, url) =>
      title === "Overview" && url === "/docs/channels/overview" ? "Channels" : title,
    templates: [
      { slug: "chat", title: "Chat agent template", description: "A persisted chat agent." },
    ],
  });

describe("transformSitemapMarkdown", () => {
  it("disambiguates Overview titles and adds canonical HTML identity", () => {
    const output = transform(
      "- [Overview](/docs/channels/overview) | Type: Conceptual | Summary: Channel docs",
    );

    expect(output).toContain(
      "- [Channels](/docs/channels/overview) | Type: Conceptual | Summary: Channel docs | Canonical: /docs/channels/overview",
    );
  });

  it.each([
    ["/docs/guides/hooks", "Guide", "How-to"],
    ["/docs/tutorial/first-agent", "Conceptual", "How-to"],
    ["/docs/concepts/context-control", "Conceptual", "Conceptual"],
    ["/docs/reference/cli", "Reference", "Reference"],
  ])("classifies %s as %s", (url, inputType, expectedType) => {
    const output = transform(`- [Page](${url}) | Type: ${inputType} | Summary: Page summary`);
    expect(output).toContain(`Type: ${expectedType} | Summary:`);
  });

  it("adds concise template discovery without embedding template source", () => {
    const output = transform("# Documentation Sitemap");

    expect(output).toContain(
      "- [Chat agent template](/templates/chat) | Type: Example | Summary: A persisted chat agent. | Canonical: /templates/chat",
    );
  });
});
