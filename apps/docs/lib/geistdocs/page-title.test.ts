import { describe, expect, it } from "vitest";
import { resolveDocsPageTitle } from "./page-title";

describe("resolveDocsPageTitle", () => {
  it.each([
    ["/docs/agent-config", "Agent configuration (agent.ts)"],
    ["/docs/concepts/sessions-runs-and-streaming", "Agent sessions, runs, and streaming"],
    ["/docs/getting-started", "Get started with eve: durable AI agents in TypeScript"],
    ["/docs/guides/frontend/overview", "Build an AI agent chat UI with useEveAgent"],
    ["/docs/reference/project-layout", "agent/ directory reference"],
    ["/docs/reference/typescript-api", "TypeScript API reference"],
    ["/docs/tutorial/first-agent", "Build your first agent"],
  ])("uses the explicit SEO title for %s", (pageUrl, expected) => {
    expect(resolveDocsPageTitle({ pageTitle: "Visible title", pageUrl, tree: {} })).toBe(expected);
  });

  it("uses an explicit SEO title before resolving an Overview parent", () => {
    expect(
      resolveDocsPageTitle({
        pageTitle: "Overview",
        pageUrl: "/docs/guides/frontend/overview",
        tree: {
          name: "Docs",
          children: [
            {
              type: "folder",
              name: "Frontend",
              children: [{ type: "page", name: "Overview", url: "/docs/guides/frontend/overview" }],
            },
          ],
        },
      }),
    ).toBe("Build an AI agent chat UI with useEveAgent");
  });

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
