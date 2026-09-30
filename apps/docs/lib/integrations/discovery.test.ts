import { getIntegrationEntry } from "@eve/catalog";
import { describe, expect, it } from "vitest";
import { getIntegration, integrations } from "./data";
import { integrationMarkdown, integrationPaths, integrationSearchText } from "./discovery";

const SECTIONS = ["## Install", "## Quick start", "## Configure"] as const;

function sectionBody(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n\n`);
  if (start === -1) return "";
  const bodyStart = start + heading.length + 2;
  const next = markdown.indexOf("\n\n## ", bodyStart);
  return markdown.slice(bodyStart, next === -1 ? undefined : next).trim();
}

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
    expect(markdown).toContain("eve add channel/slack");
  });

  it.each(integrations.map((integration) => [integration.slug, integration] as const))(
    "renders %s as complete agent-readable setup",
    (slug, integration) => {
      const markdown = integrationMarkdown(integration);
      const offsets = SECTIONS.map((heading) => markdown.indexOf(`${heading}\n\n`));

      expect(offsets.every((offset) => offset !== -1)).toBe(true);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      for (const heading of SECTIONS) expect(sectionBody(markdown, heading)).not.toBe("");
      expect(markdown).toContain(`](${integration.docsHref})`);
      expect(integrationSearchText(integration)).toContain(integration.name);
      if (getIntegrationEntry(slug)?.surfaces.registry) expect(markdown).toContain("eve add ");

      const related = markdown.indexOf("## Related resources");
      if (!integration.relatedResources?.length) {
        expect(related).toBe(-1);
        return;
      }
      expect(related).toBeGreaterThan(offsets[2]!);
      for (const resource of integration.relatedResources) {
        expect(markdown).toContain(`- [${resource.title}](${resource.href})`);
      }
    },
  );

  it("renders Buzz as an ACP channel with explicit authorization guidance", () => {
    const buzz = getIntegration("buzz");
    expect(buzz).toBeDefined();

    const markdown = integrationMarkdown(buzz!);
    expect(markdown).toContain("npm install --global @eve/buzz-acp-adapter");
    expect(markdown).toContain("eve-buzz-acp-adapter install");
    expect(markdown).toContain("Customize for this agent");
    expect(markdown).toContain("Agent harness** to **eve");
    expect(markdown).toContain("does not prefill one for custom harnesses");
    expect(markdown).toContain("Who can talk to this agent");
    expect(markdown).toContain("AI_GATEWAY_API_KEY");
    expect(markdown).toContain("Parallelism** to `1`");
    expect(markdown).toContain("Accepted senders share one eve identity");
    expect(markdown).toContain("## Configure");
    expect(integrationSearchText(buzz!)).toContain("acp");
  });

  it("renders every connection setup variant", () => {
    const notion = getIntegration("notion");
    expect(notion).toBeDefined();

    const markdown = integrationMarkdown(notion!);
    expect(markdown).toContain("### MCP · User");
    expect(markdown).toContain("### OpenAPI · User");
    expect(markdown).toContain("agent/connections/notion.ts");
  });

  it("renders hand-authored connection setup without generated variant headings", () => {
    const shopify = getIntegration("shopify");
    expect(shopify).toBeDefined();

    const markdown = integrationMarkdown(shopify!);
    expect(markdown).toContain('process.env.EVE_DEV === "1"');
    expect(markdown).toContain("SHOPIFY_STORE_DOMAIN");
    expect(markdown).not.toContain("### MCP ·");
  });
});
