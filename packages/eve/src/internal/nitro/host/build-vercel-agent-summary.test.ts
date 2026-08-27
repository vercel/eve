import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { buildVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import {
  normalizeChannelKindForDisplay,
  VERCEL_EVE_AGENT_SUMMARY_KIND,
  VERCEL_EVE_AGENT_SUMMARY_VERSION,
} from "#internal/vercel-agent-summary.js";

const GENERATOR_VERSION = "0.0.0-test";

describe("buildVercelAgentSummary", () => {
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
