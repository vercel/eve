import { describe, expect, it } from "vitest";
import {
  breadcrumbListNode,
  docsArticleStructuredData,
  docsBreadcrumbs,
  integrationStructuredData,
  serializeJsonLd,
  webSiteStructuredData,
} from "./structured-data";

const origin = "http://localhost:3000";

const tree = {
  name: "Docs",
  children: [
    { type: "page", name: "Getting Started", url: "/docs/getting-started" },
    {
      type: "folder",
      name: "Channels",
      children: [
        { type: "page", name: "Overview", url: "/docs/channels/overview" },
        { type: "page", name: "Slack", url: "/docs/channels/slack" },
      ],
    },
    {
      type: "folder",
      name: "Sandbox",
      index: { type: "page", name: "Sandbox", url: "/docs/sandbox" },
      children: [{ type: "page", name: "Docker", url: "/docs/sandbox/docker" }],
    },
    {
      type: "folder",
      name: "Guides",
      children: [
        { type: "page", name: "Deployment", url: "/docs/guides/deployment" },
        {
          type: "folder",
          name: "Frontend",
          children: [{ type: "page", name: "Overview", url: "/docs/guides/frontend/overview" }],
        },
      ],
    },
  ],
};

describe("structured data", () => {
  it("escapes HTML start characters in serialized JSON-LD", () => {
    expect(serializeJsonLd({ name: "</script>" })).toBe('{"name":"\\u003c/script>"}');
  });

  it("links enclosing folders to their index or first page", () => {
    expect(docsBreadcrumbs({ pageUrl: "/docs/channels/slack", title: "Slack", tree })).toEqual([
      { name: "Channels", pathname: "/docs/channels/overview" },
      { name: "Slack", pathname: "/docs/channels/slack" },
    ]);
    expect(docsBreadcrumbs({ pageUrl: "/docs/sandbox/docker", title: "Docker", tree })).toEqual([
      { name: "Sandbox", pathname: "/docs/sandbox" },
      { name: "Docker", pathname: "/docs/sandbox/docker" },
    ]);
  });

  it("omits a breadcrumb list for top-level pages and folder landing pages", () => {
    for (const [pageUrl, title] of [
      ["/docs/getting-started", "Get started"],
      ["/docs/channels/overview", "Channels"],
      ["/docs/sandbox", "Sandbox"],
    ]) {
      expect(breadcrumbListNode(docsBreadcrumbs({ pageUrl, title, tree }))).toBeUndefined();
    }
  });

  it("keeps the page name when a nested folder links to the current page", () => {
    const entries = docsBreadcrumbs({
      pageUrl: "/docs/guides/frontend/overview",
      title: "Build a chat UI",
      tree,
    });
    expect(breadcrumbListNode(entries)?.itemListElement).toEqual([
      {
        "@type": "ListItem",
        item: `${origin}/docs/guides/deployment`,
        name: "Guides",
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${origin}/docs/guides/frontend/overview`,
        name: "Build a chat UI",
        position: 2,
      },
    ]);
  });

  it("describes a docs page as a TechArticle with absolute URLs", () => {
    const data = docsArticleStructuredData({
      breadcrumbs: docsBreadcrumbs({ pageUrl: "/docs/channels/slack", title: "Slack", tree }),
      description: "Mention your agent in Slack.",
      image: "https://example.com/og.jpg",
      lang: "en",
      pathname: "/docs/channels/slack",
      title: "Slack",
    });
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          headline: "Slack",
          description: "Mention your agent in Slack.",
          image: "https://example.com/og.jpg",
          inLanguage: "en",
          isPartOf: { "@type": "WebSite", name: "eve", url: `${origin}/` },
          mainEntityOfPage: `${origin}/docs/channels/slack`,
          publisher: { "@type": "Organization", name: "Vercel", url: "https://vercel.com" },
          url: `${origin}/docs/channels/slack`,
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              item: `${origin}/docs/channels/overview`,
              name: "Channels",
              position: 1,
            },
            {
              "@type": "ListItem",
              item: `${origin}/docs/channels/slack`,
              name: "Slack",
              position: 2,
            },
          ],
        },
      ],
    });
  });

  it("adds integration breadcrumbs and homepage site identity", () => {
    expect(integrationStructuredData({ name: "Slack", pathname: "/integrations/slack" })).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", item: `${origin}/integrations`, name: "Integrations", position: 1 },
        {
          "@type": "ListItem",
          item: `${origin}/integrations/slack`,
          name: "Slack",
          position: 2,
        },
      ],
    });
    expect(webSiteStructuredData("Like Next.js for agents.")).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "eve",
      url: `${origin}/`,
      description: "Like Next.js for agents.",
      inLanguage: "en",
      publisher: { "@type": "Organization", name: "Vercel", url: "https://vercel.com" },
    });
  });
});
