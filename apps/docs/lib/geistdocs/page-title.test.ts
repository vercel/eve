import { describe, expect, it } from "vitest";
import { resolveDocsPageTitle } from "./page-title";

describe("resolveDocsPageTitle", () => {
  it("uses the sidebar parent title for an Overview page", () => {
    const tree = {
      name: "Docs",
      children: [
        {
          type: "folder",
          name: "Channels",
          children: [{ type: "page", name: "Overview", url: "/docs/channels/overview" }],
        },
      ],
    };

    expect(
      resolveDocsPageTitle({
        pageTitle: "Overview",
        pageUrl: "/docs/channels/overview",
        tree,
      }),
    ).toBe("Channels");
  });

  it("preserves the title of a non-Overview page", () => {
    const tree = {
      name: "Docs",
      children: [
        {
          type: "folder",
          name: "Channels",
          children: [{ type: "page", name: "Microsoft Teams", url: "/docs/channels/teams" }],
        },
      ],
    };

    expect(
      resolveDocsPageTitle({
        pageTitle: "Microsoft Teams",
        pageUrl: "/docs/channels/teams",
        tree,
      }),
    ).toBe("Microsoft Teams");
  });

  it("uses the folder title for an Overview index page", () => {
    const tree = {
      name: "Docs",
      children: [
        {
          type: "folder",
          name: "Connections",
          index: { type: "page", name: "Overview", url: "/docs/connections" },
          children: [],
        },
      ],
    };

    expect(
      resolveDocsPageTitle({
        pageTitle: "Overview",
        pageUrl: "/docs/connections",
        tree,
      }),
    ).toBe("Connections");
  });

  it("resolves an Overview page from the fallback tree", () => {
    const tree = {
      name: "Docs",
      children: [],
      fallback: {
        name: "Docs",
        children: [
          {
            type: "folder",
            name: "Evals",
            children: [{ type: "page", name: "Overview", url: "/docs/evals/overview" }],
          },
        ],
      },
    };

    expect(
      resolveDocsPageTitle({
        pageTitle: "Overview",
        pageUrl: "/docs/evals/overview",
        tree,
      }),
    ).toBe("Evals");
  });
});
