import { describe, expect, it } from "vitest";
import { getIntegration, integrations } from "./data";
import { integrationMarkdown, integrationPaths, integrationSearchText } from "./discovery";

describe("integration discovery", () => {
  it("includes the landing page and every detail page in crawler paths", () => {
    const paths = integrationPaths();

    expect(paths[0]).toBe("/integrations");
    expect(paths).toHaveLength(integrations.length + 1);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("/integrations/slack");
    expect(paths).toContain("/integrations/linear");
  });

  it("includes presentation keywords in searchable text", () => {
    const slack = getIntegration("slack");
    expect(slack).toBeDefined();

    expect(integrationSearchText(slack!)).toContain("Slack");
    expect(integrationSearchText(slack!)).toContain("Channel");
    expect(integrationSearchText(slack!)).toContain("messaging");
  });

  it("renders hand-authored setup as agent-readable Markdown", () => {
    const slack = getIntegration("slack");
    expect(slack).toBeDefined();

    const markdown = integrationMarkdown(slack!);
    expect(markdown).toContain("## Install");
    expect(markdown).toContain("## Quick start");
    expect(markdown).toContain("eve channels add slack");
  });

  it("renders the Browserbase extension setup", () => {
    const browserbase = getIntegration("browserbase");
    expect(browserbase).toBeDefined();

    const markdown = integrationMarkdown(browserbase!);
    expect(markdown).toContain("pnpm add @browserbasehq/eve");
    expect(markdown).toContain('import browserbase from "@browserbasehq/eve"');
    expect(markdown).toContain("BROWSERBASE_API_KEY");
    expect(integrationSearchText(browserbase!)).toContain("Stagehand");
  });

  it("renders the Jetty extension and eval reporter setup", () => {
    const jetty = getIntegration("jetty");
    expect(jetty).toBeDefined();

    const markdown = integrationMarkdown(jetty!);
    expect(markdown).toContain("pnpm add @jetty/eve");
    expect(markdown).toContain('import jetty from "@jetty/eve"');
    expect(markdown).toContain('import { Jetty } from "@jetty/eve/reporter"');
    expect(markdown).toContain("JETTY_API_TOKEN");
    expect(integrationSearchText(jetty!)).toContain("grading");
  });

  it("renders the GitHub Tools extension setup", () => {
    const githubTools = getIntegration("github-tools");
    expect(githubTools).toBeDefined();

    const markdown = integrationMarkdown(githubTools!);
    expect(markdown).toContain("pnpm add @github-tools/eve-extension");
    expect(markdown).toContain('connector: "github/my-connector"');
    expect(markdown).toContain('preset: "maintainer"');
    expect(markdown).toContain("github__addPullRequestComment");
    expect(integrationSearchText(githubTools!)).toContain("code review");
  });

  it("renders every connection setup variant", () => {
    const notion = getIntegration("notion");
    expect(notion).toBeDefined();

    const markdown = integrationMarkdown(notion!);
    expect(markdown).toContain("### MCP · User");
    expect(markdown).toContain("### OpenAPI · User");
    expect(markdown).toContain("agent/connections/notion.ts");
  });
});
