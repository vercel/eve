import { describe, expect, it } from "vitest";
import { resolveDocsPageTitle } from "./page-title";

describe("resolveDocsPageTitle", () => {
  it.each([
    ["/docs/agent-config", "Agent configuration (agent.ts)"],
    ["/docs/concepts/sessions-runs-and-streaming", "Agent sessions, runs, and streaming"],
    ["/docs/getting-started", "Get started with eve: durable AI agents in TypeScript"],
    ["/docs/guides/frontend", "Build an AI agent chat UI with useEveAgent"],
    ["/docs/reference/typescript-api", "TypeScript API reference"],
    ["/docs/tutorial/first-agent", "Build your first agent"],
  ])("uses the explicit SEO title for %s", (pageUrl, expected) => {
    expect(resolveDocsPageTitle({ pageTitle: "Visible title", pageUrl })).toBe(expected);
  });

  it("uses the page title otherwise", () => {
    expect(
      resolveDocsPageTitle({ pageTitle: "Microsoft Teams", pageUrl: "/docs/channels/teams" }),
    ).toBe("Microsoft Teams");
  });
});
