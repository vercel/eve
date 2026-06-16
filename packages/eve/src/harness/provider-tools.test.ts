import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_GATEWAY_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/web-search.js";
import {
  mergeGatewayProviderPin,
  resolveFrameworkToolFromUpstreamType,
  resolveGatewayPinForWebSearchBackend,
  resolveWebSearchBackend,
  resolveWebSearchOutputSchema,
  resolveWebSearchProviderTool,
} from "#harness/provider-tools.js";

const {
  anthropicWebSearch_20250305,
  anthropicWebSearch_20260209,
  gatewayPerplexitySearch,
  googleSearch,
  openaiWebSearch,
} = vi.hoisted(() => ({
  anthropicWebSearch_20250305: vi.fn(() => ({
    providerTool: "anthropic.webSearch_20250305",
  })),
  anthropicWebSearch_20260209: vi.fn(() => ({
    providerTool: "anthropic.webSearch_20260209",
  })),
  gatewayPerplexitySearch: vi.fn(() => ({ providerTool: "gateway.perplexitySearch" })),
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
        perplexitySearch: gatewayPerplexitySearch,
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
    gatewayPerplexitySearch.mockClear();
    googleSearch.mockClear();
    openaiWebSearch.mockClear();
  });

  it("returns 'openai' for an OpenAI gateway model", () => {
    const ref: RuntimeModelReference = { id: "openai/gpt-5.4" };
    expect(resolveWebSearchBackend(ref)).toBe("openai");
  });

  it("returns 'openai' for a BYO OpenAI model", () => {
    const ref: RuntimeModelReference = {
      id: "openai.chat/gpt-5.4",
      source: {
        exportName: "openai",
        sourceKind: "module",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
      },
    };
    expect(resolveWebSearchBackend(ref)).toBe("openai");
  });

  it("returns 'anthropic' for an Anthropic gateway model", () => {
    const ref: RuntimeModelReference = { id: "anthropic/claude-opus-4.6" };
    expect(resolveWebSearchBackend(ref)).toBe("anthropic");
  });

  it("returns 'anthropic' for a BYO Anthropic model", () => {
    const ref: RuntimeModelReference = {
      id: "anthropic.messages/claude-opus-4.6",
      source: {
        exportName: "anthropic",
        sourceKind: "module",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
      },
    };
    expect(resolveWebSearchBackend(ref)).toBe("anthropic");
  });

  it("returns 'google' for a BYO Google model", () => {
    const ref: RuntimeModelReference = {
      id: "google.generative-ai/gemini-3.1-pro",
      source: {
        exportName: "google",
        sourceKind: "module",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
      },
    };
    expect(resolveWebSearchBackend(ref)).toBe("google");
  });

  it("returns 'gateway' for a Google model on AI Gateway", () => {
    const ref: RuntimeModelReference = { id: "google/gemini-3.1-pro" };
    expect(resolveWebSearchBackend(ref)).toBe("gateway");
  });

  it("returns 'gateway' for a non-OpenAI/Anthropic/Google gateway model", () => {
    const ref: RuntimeModelReference = { id: "mistral/mistral-large" };
    expect(resolveWebSearchBackend(ref)).toBe("gateway");
  });

  it("returns null for a BYO non-OpenAI/Anthropic/Google model", () => {
    const ref: RuntimeModelReference = {
      id: "some-provider/some-model",
      source: {
        exportName: "model",
        sourceKind: "module",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
      },
    };
    expect(resolveWebSearchBackend(ref)).toBeNull();
  });

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

  it("uses gateway perplexitySearch for the gateway fallback backend", async () => {
    const tool = await resolveWebSearchProviderTool("gateway");

    expect(gatewayPerplexitySearch).toHaveBeenCalledTimes(1);
    expect(tool).toMatchObject({ providerTool: "gateway.perplexitySearch" });
    expect(getOutputJsonSchema(tool)).toEqual(WEB_SEARCH_GATEWAY_OUTPUT_SCHEMA);
  });

  it("resolves output schemas per selected backend", () => {
    expect(resolveWebSearchOutputSchema("anthropic")).toBe(WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("gateway")).toBe(WEB_SEARCH_GATEWAY_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("google")).toBe(WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA);
    expect(resolveWebSearchOutputSchema("openai")).toBe(WEB_SEARCH_OPENAI_OUTPUT_SCHEMA);
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

describe("resolveGatewayPinForWebSearchBackend", () => {
  it("pins to the matching provider for direct provider backends", () => {
    expect(resolveGatewayPinForWebSearchBackend("anthropic")).toBe("anthropic");
    expect(resolveGatewayPinForWebSearchBackend("openai")).toBe("openai");
    expect(resolveGatewayPinForWebSearchBackend("google")).toBe("google");
  });

  it("returns null for the gateway-native Perplexity backend", () => {
    expect(resolveGatewayPinForWebSearchBackend("gateway")).toBeNull();
  });
});

describe("mergeGatewayProviderPin", () => {
  it("adds gateway.only when the base has no gateway section", () => {
    expect(mergeGatewayProviderPin(undefined, "anthropic")).toEqual({
      gateway: { only: ["anthropic"] },
    });
  });

  it("preserves other gateway fields while adding only", () => {
    expect(mergeGatewayProviderPin({ gateway: { caching: "auto" } }, "anthropic")).toEqual({
      gateway: { caching: "auto", only: ["anthropic"] },
    });
  });

  it("preserves unrelated providerOptions keys", () => {
    expect(
      mergeGatewayProviderPin(
        { anthropic: { thinking: { type: "adaptive" } }, gateway: { caching: "auto" } },
        "anthropic",
      ),
    ).toEqual({
      anthropic: { thinking: { type: "adaptive" } },
      gateway: { caching: "auto", only: ["anthropic"] },
    });
  });

  it("does not overwrite an author-supplied gateway.only", () => {
    expect(mergeGatewayProviderPin({ gateway: { only: ["bedrock"] } }, "anthropic")).toEqual({
      gateway: { only: ["bedrock"] },
    });
  });

  it("does not overwrite an author-supplied gateway.order", () => {
    expect(
      mergeGatewayProviderPin({ gateway: { order: ["anthropic", "bedrock"] } }, "anthropic"),
    ).toEqual({ gateway: { order: ["anthropic", "bedrock"] } });
  });
});
