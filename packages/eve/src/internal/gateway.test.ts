import { gateway } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  context as apiContext,
  propagation as apiPropagation,
  ROOT_CONTEXT,
  trace as apiTrace,
} from "@opentelemetry/api";
import {
  AI_GATEWAY_MODELS_CATALOG_URL,
  AI_GATEWAY_MODELS_URL,
  vercelGatewayFetch,
  resolveGatewayTraceContextHeaders,
  resolveProviderHeaders,
} from "#internal/gateway.js";

const TRACE_ID = "1".repeat(32);

function contextFor(spanId: string) {
  return apiTrace.setSpan(
    ROOT_CONTEXT,
    apiTrace.wrapSpanContext({
      isRemote: true,
      spanId,
      traceFlags: 1,
      traceId: TRACE_ID,
    }),
  );
}

beforeEach(() => {
  apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  apiPropagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterEach(() => {
  apiPropagation.disable();
  apiContext.disable();
  vi.unstubAllGlobals();
});

describe("Gateway endpoints", () => {
  it("point at the Gateway origin", () => {
    expect(AI_GATEWAY_MODELS_URL).toBe("https://ai-gateway.vercel.sh/v1/models");
    expect(AI_GATEWAY_MODELS_CATALOG_URL).toBe("https://ai-gateway.vercel.sh/v1/models/catalog");
  });
});

describe("vercelGatewayFetch", () => {
  it("sends the eve product token as the user-agent", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", inner);
    try {
      await vercelGatewayFetch(AI_GATEWAY_MODELS_URL);
    } finally {
      vi.unstubAllGlobals();
    }

    const [, init] = inner.mock.calls[0]!;
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^eve\/.+/);
  });
});

describe("resolveProviderHeaders", () => {
  it("returns the eve user-agent for bare model ids", () => {
    expect(resolveProviderHeaders("anthropic/claude-sonnet-4-5")).toEqual({
      "user-agent": expect.stringMatching(/^eve\/.+/),
    });
  });

  it("returns the eve user-agent for gateway model instances", () => {
    const model = new MockLanguageModelV3({
      provider: "gateway.language-model",
      modelId: "anthropic/claude-sonnet-4-5",
    });
    expect(resolveProviderHeaders(model)).toEqual({
      "user-agent": expect.stringMatching(/^eve\/.+/),
    });
  });

  it("returns undefined for direct-provider model instances", () => {
    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveProviderHeaders(model)).toBeUndefined();
  });
});

describe("resolveGatewayTraceContextHeaders", () => {
  it("adds the active context to bare ids routed through the default Gateway provider", () => {
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", gateway);
    const headers = apiContext.with(contextFor("2".repeat(16)), () =>
      resolveGatewayTraceContextHeaders("anthropic/claude-sonnet-4-5", {
        "x-eve-test": "preserved",
      }),
    );

    expect(headers).toEqual({
      traceparent: `00-${TRACE_ID}-${"2".repeat(16)}-01`,
      "x-eve-test": "preserved",
    });
  });

  it("leaves direct-provider headers unchanged", () => {
    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
    });
    const headers = { "x-eve-test": "preserved" };
    const resolvedHeaders = apiContext.with(contextFor("3".repeat(16)), () =>
      resolveGatewayTraceContextHeaders(model, headers),
    );

    expect(resolvedHeaders).toBe(headers);
  });
});
