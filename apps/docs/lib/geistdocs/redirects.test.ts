import { describe, expect, it } from "vitest";
import { createDocsRedirects, docsRedirects } from "./redirects";

describe("createDocsRedirects", () => {
  it("preserves Markdown negotiation across default and localized paths", () => {
    expect(createDocsRedirects("/channels", "/channels/overview")).toEqual([
      {
        source: "/docs/channels",
        destination: "/docs/channels/overview",
        permanent: true,
      },
      {
        source: "/:lang/docs/channels",
        destination: "/:lang/docs/channels/overview",
        permanent: true,
      },
      {
        source: "/docs/channels.md",
        destination: "/docs/channels/overview.md",
        permanent: true,
      },
      {
        source: "/:lang/docs/channels.md",
        destination: "/:lang/docs/channels/overview.md",
        permanent: true,
      },
      {
        source: "/docs/channels.mdx",
        destination: "/docs/channels/overview.mdx",
        permanent: true,
      },
      {
        source: "/:lang/docs/channels.mdx",
        destination: "/:lang/docs/channels/overview.mdx",
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
    ["/docs/evals", "/docs/evals/overview"],
  ])("redirects %s to %s", (source, destination) => {
    expect(docsRedirects).toContainEqual({ source, destination, permanent: true });
  });
});
