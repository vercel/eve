import { beforeEach, describe, expect, it, vi } from "vitest";

import { MockLanguageModelV3 } from "ai/test";

import { resolveModelProfile } from "#harness/model-profile.js";
import type { WebSearchSelection } from "#shared/web-search.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_EXA_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
} from "#harness/provider-tool-schemas.js";
import {
  resolveFrameworkToolFromUpstreamType,
  resolveWebSearchBackend,
  resolveWebSearchOutputSchema,
  resolveWebSearchProviderTool,
} from "#harness/provider-tools.js";

const {
  anthropicWebSearch_20250305,
  anthropicWebSearch_20260209,
  gatewayExaSearch,
  gatewayParallelSearch,
  googleSearch,
  openaiWebSearch,
} = vi.hoisted(() => ({
  anthropicWebSearch_20250305: vi.fn(() => ({
    providerTool: "anthropic.webSearch_20250305",
  })),
  anthropicWebSearch_20260209: vi.fn(() => ({
    providerTool: "anthropic.webSearch_20260209",
  })),
  gatewayExaSearch: vi.fn(() => ({ providerTool: "gateway.exaSearch" })),
  gatewayParallelSearch: vi.fn(() => ({ providerTool: "gateway.parallelSearch" })),
  googleSearch: vi.fn(() => ({ providerTool: "google.googleSearch" })),
  openaiWebSearch: vi.fn(() => ({ providerTool: "openai.webSearch" })),
}));

vi.mock("#compiled/@ai-sdk/anthropic/index.js", () => ({
  anthropic: {
    tools: {
      webSearch_20250305: anthropicWebSearch_20250305,
      webSearch_20260209: anthropicWebSearch_20260209,
    },
  },
}));

vi.mock("#compiled/@ai-sdk/google/index.js", () => ({
  google: {
    tools: {
      googleSearch,
    },
  },
}));

vi.mock("#compiled/@ai-sdk/openai/index.js", () => ({
  openai: {
    tools: {
      webSearch: openaiWebSearch,
    },
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    gateway: {
      tools: {
        exaSearch: gatewayExaSearch,
        parallelSearch: gatewayParallelSearch,
      },
    },
  };
});

function getOutputJsonSchema(tool: unknown): unknown {
  return (tool as { outputSchema: { jsonSchema: unknown } }).outputSchema.jsonSchema;
}

describe("resolveWebSearchBackend", () => {
  beforeEach(() => {
    anthropicWebSearch_20250305.mockClear();
    anthropicWebSearch_20260209.mockClear();
    gatewayExaSearch.mockClear();
    gatewayParallelSearch.mockClear();
    googleSearch.mockClear();
    openaiWebSearch.mockClear();
  });

  it.each<[string, WebSearchSelection | undefined, string | null]>([
    ["openai/gpt-5.4", undefined, "exa"],
    ["openai/gpt-5.4", { provider: "parallel" }, "parallel"],
    ["anthropic/claude-opus-4.6", undefined, "exa"],
    ["openai/gpt-5.4", { provider: "native" }, "openai"],
    ["anthropic/claude-opus-4.6", { provider: "native" }, "anthropic"],
    ["google/gemini-3-flash", { provider: "native" }, "google"],
    // Native search would drop a pre-Gemini 3 model's other tools; models without one use the
    // fallback, if any.
    ["google/gemini-2.5-flash", { provider: "native" }, null],
    ["xai/grok-4", { provider: "native" }, null],
    ["xai/grok-4", { fallback: "parallel", provider: "native" }, "parallel"],
  ])("uses Gateway search for Gateway model %s with %o", (model, selection, expected) => {
    expect(resolveWebSearchBackend(resolveModelProfile(model), selection)).toBe(expected);
  });

  it.each([
    ["openai.responses", "openai"],
    ["anthropic.messages", "anthropic"],
    ["google.generative-ai", "google"],
    ["google.generative-ai", null, "gemini-2.5-pro"],
    ["openrouter.chat", null],
    ["some-provider", null],
  ] as const)(
    "uses native search for direct provider %s when it has one",
    (provider, expected, modelId?: string) => {
      const model = new MockLanguageModelV3({ modelId, provider });
      expect(resolveWebSearchBackend(resolveModelProfile(model))).toBe(expected);
    },
  );

  it("uses Anthropic webSearch_20250305 to avoid the unsupported beta header", async () => {
    const tool = await resolveWebSearchProviderTool("anthropic");

    expect(anthropicWebSearch_20250305).toHaveBeenCalledTimes(1);
    expect(anthropicWebSearch_20260209).not.toHaveBeenCalled();
    expect(tool).toMatchObject({ providerTool: "anthropic.webSearch_20250305" });
    expect(getOutputJsonSchema(tool)).toEqual(WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA);
  });

  it("uses OpenAI webSearch for the OpenAI backend", async () => {
    const tool = await resolveWebSearchProviderTool("openai");

    expect(openaiWebSearch).toHaveBeenCalledTimes(1);
    expect(tool).toMatchObject({ providerTool: "openai.webSearch" });
    expect(getOutputJsonSchema(tool)).toEqual(WEB_SEARCH_OPENAI_OUTPUT_SCHEMA);
  });

  it("uses Google googleSearch for the Google backend", async () => {
    const tool = await resolveWebSearchProviderTool("google");

    expect(googleSearch).toHaveBeenCalledTimes(1);
    expect(tool).toMatchObject({ providerTool: "google.googleSearch" });
    expect(getOutputJsonSchema(tool)).toEqual(WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA);
  });

  it("uses gateway exaSearch for the Exa backend", async () => {
    const tool = await resolveWebSearchProviderTool("exa");

    expect(gatewayExaSearch).toHaveBeenCalledWith({
      contents: { highlights: { maxCharacters: 1_000 } },
      numResults: 10,
    });
    expect(tool).toMatchObject({ providerTool: "gateway.exaSearch" });
    expect(getOutputJsonSchema(tool)).toEqual(WEB_SEARCH_EXA_OUTPUT_SCHEMA);
  });

  it("uses gateway parallelSearch for the Parallel backend", async () => {
    const tool = await resolveWebSearchProviderTool("parallel");

    expect(gatewayParallelSearch).toHaveBeenCalledTimes(1);
    expect(tool).toMatchObject({ providerTool: "gateway.parallelSearch" });
    expect(getOutputJsonSchema(tool)).toEqual(WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA);
  });

  it("resolves output schemas per selected backend", () => {
    expect(resolveWebSearchOutputSchema("anthropic")).toBe(WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("exa")).toBe(WEB_SEARCH_EXA_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("google")).toBe(WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("openai")).toBe(WEB_SEARCH_OPENAI_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("parallel")).toBe(WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA);
  });
});

describe("resolveFrameworkToolFromUpstreamType", () => {
  it("maps the Anthropic web_search_20250305 type back to web_search", () => {
    expect(resolveFrameworkToolFromUpstreamType("web_search_20250305")).toBe("web_search");
  });

  it("returns null for unknown upstream tool types", () => {
    expect(resolveFrameworkToolFromUpstreamType("computer_20251022")).toBeNull();
    expect(resolveFrameworkToolFromUpstreamType("some.future.tool")).toBeNull();
  });
});
