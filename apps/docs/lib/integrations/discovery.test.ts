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
    expect(markdown).toContain("eve add channel/slack");
  });

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

  it("renders the Web Chat setup for every host framework it documents", () => {
    const web = getIntegration("eve");
    expect(web).toBeDefined();

    const markdown = integrationMarkdown(web!);
    expect(markdown).toContain("eve add channel/web");
    expect(markdown).toContain("/docs/guides/frontend/nextjs");
    expect(markdown).toContain("/docs/guides/frontend/nuxt");
    expect(markdown).toContain("/docs/guides/frontend/sveltekit");
    expect(integrationSearchText(web!)).toContain("svelte");
  });

  it("renders the Browserbase extension setup", () => {
    const browserbase = getIntegration("browserbase");
    expect(browserbase).toBeDefined();

    const markdown = integrationMarkdown(browserbase!);
    expect(markdown).toContain("eve add extension/browserbase");
    expect(markdown).toContain('import browserbase from "@browserbasehq/eve"');
    expect(markdown).toContain("BROWSERBASE_API_KEY");
    expect(integrationSearchText(browserbase!)).toContain("Stagehand");
  });

  it("renders the BlitzReels extension setup", () => {
    const blitzreels = getIntegration("blitzreels");
    expect(blitzreels).toBeDefined();

    const markdown = integrationMarkdown(blitzreels!);
    expect(markdown).toContain("eve add extension/blitzreels");
    expect(markdown).toContain('import blitzreels from "@blitzreels/eve"');
    expect(markdown).toContain("BLITZREELS_API_KEY");
    expect(markdown).toContain("blitzreels__create_clip_batch");
    expect(markdown).toContain("require eve approval");
    expect(integrationSearchText(blitzreels!)).toContain("video editing");
  });

  it("renders the Mux Video extension setup", () => {
    const muxVideo = getIntegration("mux-video");
    expect(muxVideo).toBeDefined();

    const markdown = integrationMarkdown(muxVideo!);
    expect(markdown).toContain("github.com/muxinc/mux-video-agent.git");
    expect(markdown).toContain('import muxVideo from "@mux/eve-video"');
    expect(markdown).toContain("MUX_TOKEN_ID");
    expect(markdown).toContain("mux_video__run_workflow");
    expect(markdown).toContain("require explicit human approval");
    expect(integrationSearchText(muxVideo!)).toContain("Mux Robots");
  });

  it("renders the Jetty extension and eval reporter setup", () => {
    const jetty = getIntegration("jetty");
    expect(jetty).toBeDefined();

    const markdown = integrationMarkdown(jetty!);
    expect(markdown).toContain("eve add extension/jetty");
    expect(markdown).toContain('import jetty from "@jetty/eve"');
    expect(markdown).toContain('import { Jetty } from "@jetty/eve/reporter"');
    expect(markdown).toContain("JETTY_API_TOKEN");
    expect(integrationSearchText(jetty!)).toContain("grading");
  });

  it("renders the Upstash AgentKit extension setup", () => {
    const agentkit = getIntegration("upstash-agentkit");
    expect(agentkit).toBeDefined();

    const markdown = integrationMarkdown(agentkit!);
    expect(markdown).toContain("eve add extension/upstash-agentkit");
    expect(markdown).toContain('import agentkit from "@upstash/agentkit-eve-extension"');
    expect(markdown).toContain("UPSTASH_REDIS_REST_URL");
    expect(markdown).toContain("agentkit__recall_memory");
    expect(markdown).toContain("chatHistory: true");
    expect(integrationSearchText(agentkit!)).toContain("long-term memory");
  });

  it("renders the Kybernesis Arcana memory extension setup", () => {
    const arcana = getIntegration("arcana");
    expect(arcana).toBeDefined();

    const markdown = integrationMarkdown(arcana!);
    expect(markdown).toContain("eve add extension/arcana");
    expect(markdown).toContain('import arcana from "@kybernesis/arcana"');
    expect(markdown).toContain("ARCANA_API_KEY");
    expect(markdown).toContain("ARCANA_WORKSPACE");
    expect(integrationSearchText(arcana!)).toContain("long-term memory");
  });

  it("renders the Supermemory provider setup", () => {
    const supermemory = getIntegration("supermemory");
    expect(supermemory).toBeDefined();

    const markdown = integrationMarkdown(supermemory!);
    expect(markdown).toContain("eve add memory/supermemory");
    expect(markdown).toContain('import supermemory from "@supermemory/eve"');
    expect(markdown).toContain("SUPERMEMORY_API_KEY");
    expect(markdown).toContain("supermemory__search");
    expect(integrationSearchText(supermemory!)).toContain("Memory provider");
  });

  it("renders built-in file-memory provisioning guidance", () => {
    const file = getIntegration("file");
    expect(file).toBeDefined();

    const markdown = integrationMarkdown(file!);
    expect(markdown).toContain("eve add memory/file");
    expect(markdown).toContain("eve integration setup file-memory");
    expect(markdown).toContain("EVE_MEMORY_BLOB_STORE_ID");
    expect(integrationSearchText(file!)).toContain("Memory provider");
  });

  it("renders the Hindsight memory extension setup", () => {
    const hindsight = getIntegration("hindsight");
    expect(hindsight).toBeDefined();

    const markdown = integrationMarkdown(hindsight!);
    expect(markdown).toContain("eve add extension/hindsight");
    expect(markdown).toContain('import { hindsightMemory } from "@vectorize-io/hindsight-eve"');
    expect(markdown).toContain("hindsightRetainHook");
    expect(markdown).toContain("HINDSIGHT_API_KEY");
    expect(markdown).toContain("HINDSIGHT_BANK_ID");
    expect(integrationSearchText(hindsight!)).toContain("long-term memory");
  });

  it("renders the GitHub Tools extension setup", () => {
    const githubTools = getIntegration("github-tools");
    expect(githubTools).toBeDefined();

    const markdown = integrationMarkdown(githubTools!);
    expect(markdown).toContain("eve add extension/github-tools");
    expect(markdown).toContain('connector: "github/my-connector"');
    expect(markdown).toContain('preset: "maintainer"');
    expect(markdown).toContain("github__addPullRequestComment");
    expect(integrationSearchText(githubTools!)).toContain("code review");
  });

  it("renders the Blooio channel setup", () => {
    const blooio = getIntegration("blooio");
    expect(blooio).toBeDefined();

    const markdown = integrationMarkdown(blooio!);
    expect(markdown).toContain("eve add channel/blooio");
    expect(markdown).toContain('import { blooioChannel } from "eve-channel-blooio"');
    expect(markdown).toContain("BLOOIO_API_KEY");
    expect(markdown).toContain("BLOOIO_WEBHOOK_SECRET");
    expect(integrationSearchText(blooio!)).toContain("iMessage");
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

  it("renders instrumentation providers with registry installation", () => {
    const braintrust = getIntegration("braintrust");
    expect(braintrust).toBeDefined();

    const markdown = integrationMarkdown(braintrust!);
    expect(markdown).toContain("eve add instrumentation/braintrust");
    expect(markdown).toContain("agent/instrumentation.ts");
    expect(markdown).toContain("BRAINTRUST_API_KEY");

    const posthog = getIntegration("posthog-instrumentation");
    expect(posthog).toBeDefined();

    const posthogMarkdown = integrationMarkdown(posthog!);
    expect(posthogMarkdown).toContain("eve add instrumentation/posthog");
    expect(posthogMarkdown).toContain("PostHogTraceExporter");
    expect(posthogMarkdown).toContain("POSTHOG_PROJECT_TOKEN");
  });
});
