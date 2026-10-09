import {
  context as apiContext,
  propagation as apiPropagation,
  ROOT_CONTEXT,
  trace as apiTrace,
  type Context,
} from "@opentelemetry/api";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { createGateway } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayTraceContext } from "#harness/model-call/model.js";
import { resolveModelProfile } from "#harness/model-profile.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";

const TRACE_ID = "1".repeat(32);

describe("Gateway trace propagation", () => {
  beforeEach(() => {
    apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    apiPropagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      }),
    );
  });

  afterEach(() => {
    apiPropagation.disable();
    apiContext.disable();
    vi.unstubAllGlobals();
  });

  it("injects the active call context for each generate and stream request", async () => {
    const requestHeaders: Headers[] = [];
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      requestHeaders.push(new Headers(init?.headers));
      if (requestHeaders.length === 3) {
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const gatewayProvider = createGateway({ apiKey: "gateway-test", fetch: fetcher });
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", gatewayProvider);
    const model = gatewayProvider.languageModel("anthropic/claude-sonnet-4-5") as LanguageModelV4;
    const tracedModel = withGatewayTraceContext(
      model,
      resolveModelProfile(model),
    ) as LanguageModelV4;
    const callOptions: LanguageModelV4CallOptions = {
      headers: { "x-eve-test": "preserved" },
      prompt: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
    };
    const baggage = apiPropagation.createBaggage({
      "eve.audience": { value: "private" },
      "eve.conversation.id": { value: "conversation-1" },
      "eve.parent_session": { value: "parent-1" },
      "vendor.request": { value: "keep" },
    });
    const contextFor = (spanId: string) =>
      apiPropagation.setBaggage(
        apiTrace.setSpan(
          ROOT_CONTEXT,
          apiTrace.wrapSpanContext({
            isRemote: true,
            spanId,
            traceFlags: 1,
            traceId: TRACE_ID,
          }),
        ),
        baggage,
      );

    await apiContext.with(contextFor("2".repeat(16)), () => tracedModel.doGenerate(callOptions));
    await apiContext.with(contextFor("3".repeat(16)), () => tracedModel.doGenerate(callOptions));
    const stream = await apiContext.with(contextFor("4".repeat(16)), () =>
      tracedModel.doStream(callOptions),
    );
    await stream.stream.cancel();

    expect(requestHeaders.map((headers) => headers.get("traceparent"))).toEqual([
      `00-${TRACE_ID}-${"2".repeat(16)}-01`,
      `00-${TRACE_ID}-${"3".repeat(16)}-01`,
      `00-${TRACE_ID}-${"4".repeat(16)}-01`,
    ]);
    expect(requestHeaders[0]?.get("x-eve-test")).toBe("preserved");
    expect(requestHeaders[0]?.get("baggage")).toBe("vendor.request=keep");
  });

  it("does not inject context when tracing is suppressed", async () => {
    const requestHeaders: Headers[] = [];
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      requestHeaders.push(new Headers(init?.headers));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const model = createGateway({ apiKey: "gateway-test", fetch: fetcher }).languageModel(
      "anthropic/claude-sonnet-4-5",
    ) as LanguageModelV4;
    const tracedModel = withGatewayTraceContext(
      model,
      resolveModelProfile(model),
    ) as LanguageModelV4;
    const activeContext = apiTrace.setSpan(
      ROOT_CONTEXT,
      apiTrace.wrapSpanContext({
        isRemote: true,
        spanId: "5".repeat(16),
        traceFlags: 1,
        traceId: TRACE_ID,
      }),
    );

    await apiContext.with(suppressTracing(activeContext) as Context, () =>
      tracedModel.doGenerate({
        prompt: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
      }),
    );

    expect(requestHeaders).toHaveLength(1);
    expect(requestHeaders[0]?.get("traceparent")).toBeNull();
  });

  it("wraps bare Gateway ids without a configured default provider", () => {
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", undefined);

    const model = withGatewayTraceContext(
      "anthropic/claude-sonnet-4-5",
      resolveModelProfile("anthropic/claude-sonnet-4-5"),
    );

    expect(typeof model).not.toBe("string");
    expect(typeof model === "string" ? undefined : model.provider).toBe("gateway");
  });

  it("leaves direct-provider models and custom defaults unchanged", () => {
    const directModel = new MockLanguageModelV3({ provider: "anthropic" });
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", {
      languageModel: vi.fn(() => directModel),
    });

    expect(withGatewayTraceContext(directModel, resolveModelProfile(directModel))).toBe(
      directModel,
    );
    expect(
      withGatewayTraceContext(
        "anthropic/claude-sonnet-4-5",
        resolveModelProfile("anthropic/claude-sonnet-4-5"),
      ),
    ).toBe("anthropic/claude-sonnet-4-5");
  });
});
