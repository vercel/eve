import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { isDeferredTool, resolveToolSearchBackend } from "#harness/provider-tools.js";
import { buildToolSetFromDefinitions } from "#harness/tools.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

const DEFER = { anthropic: { deferLoading: true }, openai: { deferLoading: true } };

function definition(overrides: Partial<HarnessToolDefinition>): HarnessToolDefinition {
  return {
    description: "d",
    execute: async () => ({}),
    inputSchema: jsonSchema({ type: "object" }),
    name: "example_tool",
    ...overrides,
  };
}

function aiTool(providerOptions?: Record<string, Record<string, unknown>>): ToolSet[string] {
  return {
    description: "d",
    inputSchema: jsonSchema({ type: "object" }),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  } as ToolSet[string];
}

describe("per-tool providerOptions passthrough", () => {
  it("copies providerOptions onto the AI SDK tool object", () => {
    const toolSet = buildToolSetFromDefinitions({
      approvedTools: new Set<string>(),
      capabilities: {},
      tools: [definition({ providerOptions: DEFER })],
    });
    expect(toolSet.example_tool?.providerOptions).toEqual(DEFER);
  });

  it("omits providerOptions when the definition has none", () => {
    const toolSet = buildToolSetFromDefinitions({
      approvedTools: new Set<string>(),
      capabilities: {},
      tools: [definition({})],
    });
    expect(toolSet.example_tool).toBeDefined();
    expect(toolSet.example_tool?.providerOptions).toBeUndefined();
  });
});

describe("isDeferredTool", () => {
  it("detects the deferLoading marker for either provider", () => {
    expect(isDeferredTool(aiTool({ anthropic: { deferLoading: true } }))).toBe(true);
    expect(isDeferredTool(aiTool({ openai: { deferLoading: true } }))).toBe(true);
    expect(isDeferredTool(aiTool({ anthropic: { deferLoading: false } }))).toBe(false);
    expect(isDeferredTool(aiTool({ gateway: { caching: false } }))).toBe(false);
    expect(isDeferredTool(aiTool())).toBe(false);
  });
});

describe("resolveToolSearchBackend", () => {
  function modelRef(overrides: Partial<RuntimeModelReference>): RuntimeModelReference {
    return { id: "openai/gpt-5.6-luna", source: "authored", ...overrides } as RuntimeModelReference;
  }

  it("maps gateway model ids to their tool-search backend", () => {
    expect(resolveToolSearchBackend(modelRef({ id: "openai/gpt-5.6-luna" }))).toBe("openai");
    expect(resolveToolSearchBackend(modelRef({ id: "anthropic/claude-opus-5" }))).toBe("anthropic");
    expect(resolveToolSearchBackend(modelRef({ id: "google/gemini-3-pro" }))).toBeNull();
  });

  it("returns null for direct model instances", () => {
    expect(
      resolveToolSearchBackend(modelRef({ id: "claude-opus-5", source: undefined })),
    ).toBeNull();
  });
});
