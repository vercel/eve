import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { buildVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import {
  normalizeChannelKindForDisplay,
  VERCEL_EVE_AGENT_SUMMARY_KIND,
  VERCEL_EVE_AGENT_SUMMARY_VERSION,
} from "#internal/vercel-agent-summary.js";

const GENERATOR_VERSION = "0.0.0-test";

describe("buildVercelAgentSummary", () => {
  it.each([
    { publicRoutePrefix: undefined, urlPath: "/eve/v1/hooks/issues" },
    { publicRoutePrefix: "/support/", urlPath: "/support/eve/v1/hooks/issues" },
    { publicRoutePrefix: "/eve/support", urlPath: "/eve/support/v1/hooks/issues" },
  ])("reports opted-in event receivers at $urlPath", async ({ publicRoutePrefix, urlPath }) => {
    const auth = {
      getToken: async () => ({ token: "credential" }),
      vercelConnect: {
        connector: "oauth/issues",
        experimental_events: {
          createAdapter: async () => {
            throw new Error("must not create an adapter during build");
          },
          verify: async () => {
            throw new Error("must not verify a delivery during build");
          },
        },
      },
    };
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: ["issues", "read-only"].map((name) => ({
        logicalPath: `connections/${name}.ts`,
        loadNamespace: async () => ({
          default: defineMcpClientConnection({
            url: "https://issues.example/mcp",
            description: "Issues",
            auth,
            experimental_events: name === "issues" ? { onEvent() {} } : undefined,
          }),
        }),
      })),
    });
    const summary = buildVercelAgentSummary({ manifest, publicRoutePrefix });
    expect(summary.connections.find((entry) => entry.name === "issues")).toEqual({
      name: "issues",
      description: "Issues",
      url: "https://issues.example/mcp",
      logicalPath: "connections/issues.ts",
      type: "mcp",
      vercelConnect: { connector: "oauth/issues" },
      experimental_events: { method: "POST", urlPath },
    });
    expect(summary.connections.find((entry) => entry.name === "read-only")).not.toHaveProperty(
      "experimental_events",
    );
  });

  it("projects the effective compiled graph into the public summary", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({
            default: defineInstructions({ content: "Resolved instructions.", role: "user" }),
          }),
          logicalPath: "instructions/summary.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineChannel({
              routes: [POST("/custom", async () => new Response("ok"))],
            }),
          }),
          logicalPath: "channels/custom.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 9 * * *", markdown: "Run the digest." }),
          }),
          logicalPath: "schedules/digest.ts",
        },
      ],
      name: "summary-agent",
      skills: [{ description: "Research skill.", name: "research" }],
      tools: [{ description: "Fetch weather.", name: "weather" }],
    });

    const summary = buildVercelAgentSummary({
      generatorVersion: GENERATOR_VERSION,
      manifest,
    });

    expect(summary).toMatchObject({
      agent: { modelId: "openai/gpt-5.4", name: "summary-agent" },
      generatorVersion: GENERATOR_VERSION,
      kind: VERCEL_EVE_AGENT_SUMMARY_KIND,
      schemaVersion: VERCEL_EVE_AGENT_SUMMARY_VERSION,
    });
    expect(summary.instructions).toContainEqual({
      content: "Resolved instructions.",
      logicalPath: "instructions/summary.ts",
      role: "user",
      sourceKind: "module",
    });
    expect(summary.tools).toContainEqual({
      description: "Fetch weather.",
      logicalPath: "tools/weather.ts",
      name: "weather",
    });
    expect(summary.skills).toContainEqual({
      description: "Research skill.",
      logicalPath: "skills/research.ts",
      name: "research",
      sourceKind: "module",
    });
    expect(summary.schedules).toContainEqual({
      cron: "0 9 * * *",
      logicalPath: "schedules/digest.ts",
      name: "digest",
    });
    expect(summary.channels).toContainEqual(
      expect.objectContaining({ method: "POST", name: "custom", urlPath: "/custom" }),
    );
    expect(summary.sandbox).toEqual({ logicalPath: "sandbox.ts" });
  });

  it("surfaces the installed package version by default", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const summary = buildVercelAgentSummary({ manifest });

    expect(summary.generatorVersion.length).toBeGreaterThan(0);
  });
});

describe("normalizeChannelKindForDisplay", () => {
  it("normalizes well-known kinds to the closed display set", () => {
    expect(normalizeChannelKindForDisplay("slack")).toBe("slack");
    expect(normalizeChannelKindForDisplay("weather-slack")).toBe("slack");
    expect(normalizeChannelKindForDisplay("HTTP")).toBe("http");
    expect(normalizeChannelKindForDisplay("stripe-webhook")).toBe("webhook");
    expect(normalizeChannelKindForDisplay("custom-kind")).toBe("unknown");
    expect(normalizeChannelKindForDisplay(undefined)).toBe("unknown");
  });
});
