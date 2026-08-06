import { describe, expect, it } from "vitest";
import {
  createDocsRedirects,
  createIntegrationRedirects,
  createRootMarkdownRedirects,
  compatibilityRedirects,
  defaultLanguageRedirects,
  docsRedirects,
  rootMarkdownRedirects,
} from "./redirects";

describe("createDocsRedirects", () => {
  it("preserves Markdown negotiation across default and localized paths", () => {
    expect(createDocsRedirects("/channels", "/channels/overview")).toEqual([
      {
        source: "/docs/channels",
        destination: "/docs/channels/overview",
        permanent: true,
      },
      {
        source: "/en/docs/channels",
        destination: "/docs/channels/overview",
        permanent: true,
      },
      {
        source: "/docs/channels.md",
        destination: "/docs/channels/overview.md",
        permanent: true,
      },
      {
        source: "/en/docs/channels.md",
        destination: "/docs/channels/overview.md",
        permanent: true,
      },
      {
        source: "/docs/channels.mdx",
        destination: "/docs/channels/overview.mdx",
        permanent: true,
      },
      {
        source: "/en/docs/channels.mdx",
        destination: "/docs/channels/overview.mdx",
        permanent: true,
      },
    ]);
  });
});

describe("createRootMarkdownRedirects", () => {
  it("redirects only explicit Markdown representations into docs", () => {
    expect(createRootMarkdownRedirects("/installation", "/installation")).toEqual([
      {
        source: "/installation.md",
        destination: "/docs/installation.md",
        permanent: true,
      },
      {
        source: "/installation.mdx",
        destination: "/docs/installation.mdx",
        permanent: true,
      },
    ]);
  });
});

describe("createIntegrationRedirects", () => {
  it("preserves HTML and Markdown representations across default and localized paths", () => {
    expect(createIntegrationRedirects("chat-sdk-photon", "photon")).toEqual([
      {
        source: "/integrations/chat-sdk-photon",
        destination: "/integrations/photon",
        permanent: true,
      },
      {
        source: "/en/integrations/chat-sdk-photon",
        destination: "/integrations/photon",
        permanent: true,
      },
      {
        source: "/integrations/chat-sdk-photon.md",
        destination: "/integrations/photon.md",
        permanent: true,
      },
      {
        source: "/en/integrations/chat-sdk-photon.md",
        destination: "/integrations/photon.md",
        permanent: true,
      },
      {
        source: "/integrations/chat-sdk-photon.mdx",
        destination: "/integrations/photon.mdx",
        permanent: true,
      },
      {
        source: "/en/integrations/chat-sdk-photon.mdx",
        destination: "/integrations/photon.mdx",
        permanent: true,
      },
    ]);
  });
});

describe("docsRedirects", () => {
  it.each([
    ["/docs/channels", "/docs/channels/overview"],
    ["/docs/guides/deployment.md", "/docs/guides/deployment/overview.md"],
    ["/docs/introduction.md", "/docs/getting-started.md"],
    ["/docs/reference/http-api", "/docs/channels/eve"],
    ["/docs/project-layout", "/docs/reference/project-layout"],
    ["/docs/dynamic-capabilities", "/docs/guides/dynamic-capabilities"],
    ["/docs/dynamic-workflows", "/docs/guides/dynamic-workflows"],
    ["/docs/sessions", "/docs/concepts/sessions-runs-and-streaming"],
    ["/docs/agent", "/docs/agent-config"],
    ["/docs/evals", "/docs/evals/overview"],
  ])("redirects %s to %s", (source, destination) => {
    expect(docsRedirects).toContainEqual({ source, destination, permanent: true });
  });
});

describe("rootMarkdownRedirects", () => {
  it.each([
    ["/getting-started.mdx", "/docs/getting-started.mdx"],
    ["/tools/overview.md", "/docs/tools.md"],
    ["/channels/eve.mdx", "/docs/channels/eve.mdx"],
  ])("redirects observed root Markdown alias %s to %s", (source, destination) => {
    expect(rootMarkdownRedirects).toContainEqual({ source, destination, permanent: true });
  });

  it("does not create extensionless root redirects", () => {
    expect(
      rootMarkdownRedirects.some(
        ({ source }) => !source.endsWith(".md") && !source.endsWith(".mdx"),
      ),
    ).toBe(false);
  });
});

describe("defaultLanguageRedirects", () => {
  it("redirects observed locale aliases directly to their canonical destination", () => {
    expect(defaultLanguageRedirects).toEqual([
      {
        source: "/en/docs",
        destination: "/docs/getting-started",
        permanent: true,
      },
      {
        source: "/en/resources",
        destination: "/templates",
        permanent: true,
      },
      {
        source: "/en/:path*",
        destination: "/:path*",
        permanent: true,
      },
    ]);
  });
});

describe("all redirects", () => {
  const redirects = [
    ...compatibilityRedirects,
    ...docsRedirects,
    ...rootMarkdownRedirects,
    ...defaultLanguageRedirects,
  ];

  it("has no duplicate sources", () => {
    const sources = redirects.map(({ source }) => source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("has no redirect loops", () => {
    const destinations = new Map(redirects.map(({ source, destination }) => [source, destination]));

    for (const { source } of redirects) {
      const visited = new Set<string>();
      let current: string | undefined = source;
      while (current && destinations.has(current)) {
        expect(visited.has(current), `redirect loop from ${source}`).toBe(false);
        visited.add(current);
        current = destinations.get(current);
      }
    }
  });
});
