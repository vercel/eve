import {
  context as apiContext,
  propagation as apiPropagation,
  trace as apiTrace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  context as runtimeContext,
  ROOT_CONTEXT,
  SpanKind,
  trace as runtimeTrace,
} from "#compiled/@opentelemetry/api/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMcpTraceFetch,
  withMcpToolCallSpan,
  withMcpToolsListSpan,
} from "#runtime/connections/mcp-tracing.js";
import {
  withAgentToolContentPolicy,
  withAgentToolSpanContext,
} from "#tracing/agent-tool-span-context.js";

describe("MCP trace propagation", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    apiPropagation.setGlobalPropagator(new W3CTraceContextPropagator());
    apiTrace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    apiTrace.disable();
    apiPropagation.disable();
    apiContext.disable();
  });

  it("injects configured propagation into params._meta and annotates the tool span", async () => {
    const setAttributes = vi.fn();
    const toolContext = withAgentToolSpanContext(ROOT_CONTEXT, {
      recordInputs: false,
      recordOutputs: false,
      setAttributes,
    });
    const fetcher = vi.fn(
      async (_request: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { headers: { "mcp-session-id": "session-1" } }),
    );
    const fetch = createMcpTraceFetch({
      connectionName: "linear",
      fetcher,
      getActiveContext: () => toolContext,
      getProtocolVersion: () => "2025-11-25",
      injectContext(_context, carrier) {
        carrier.traceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
        carrier.tracestate = "vendor=value";
        carrier.baggage =
          "request=one,eve.audience=private;ceiling=i0o0,eve.conversation.id=hidden,eve.parent_session=%7B%7D";
      },
    });

    await fetch("https://mcp.example.com", {
      body: JSON.stringify({
        id: 42,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: { caller: "eve" },
          arguments: { issue: "ISSUE-1" },
          name: "get_issue",
        },
      }),
      headers: { "mcp-protocol-version": "2025-11-25" },
      method: "POST",
    });

    const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = JSON.parse(String(requestInit?.body)) as {
      readonly params: { readonly _meta: Record<string, unknown> };
    };
    expect(requestBody.params._meta).toEqual({
      baggage: "request=one",
      caller: "eve",
      traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
      tracestate: "vendor=value",
    });
    expect(requestBody.params._meta).not.toHaveProperty("recordInputs");
    expect(requestBody.params._meta).not.toHaveProperty("recordOutputs");
    expect(setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "eve.connection.name": "linear",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "get_issue",
        "jsonrpc.request.id": "42",
        "mcp.method.name": "tools/call",
        "mcp.protocol.version": "2025-11-25",
        "network.protocol.name": "http",
        "network.transport": "tcp",
      }),
    );
    expect(setAttributes).toHaveBeenCalledWith({ "mcp.session.id": "session-1" });
  });

  it("leaves oversized JSON-RPC requests untouched", async () => {
    const fetcher = vi.fn(
      async (_request: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null),
    );
    const fetch = createMcpTraceFetch({
      connectionName: "linear",
      fetcher,
      getActiveContext: () => ROOT_CONTEXT,
      getProtocolVersion: () => undefined,
      injectContext(_context, carrier) {
        carrier.traceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
      },
    });
    const body = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { value: "x".repeat(1024 * 1024) }, name: "large" },
    });

    await fetch("https://mcp.example.com", { body, method: "POST" });

    const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit?.body).toBe(body);
  });

  it("propagates the fallback CLIENT span context for tools/call", async () => {
    const parent = runtimeTrace.getTracer("test.mcp").startSpan("parent");
    const parentContext = withAgentToolContentPolicy(runtimeTrace.setSpan(ROOT_CONTEXT, parent), {
      recordInputs: true,
      recordOutputs: true,
    });
    const fetcher = vi.fn(
      async (_request: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { headers: { "mcp-session-id": "session-1" } }),
    );
    const fetch = createMcpTraceFetch({
      connectionName: "linear",
      fetcher,
      getProtocolVersion: () => "2025-11-25",
    });
    const result = {
      content: [{ text: "Issue title", type: "text" }],
      isError: false,
    };

    await runtimeContext.with(parentContext, async () => {
      await withMcpToolCallSpan({
        arguments: { issue: "ISSUE-1" },
        connectionName: "linear",
        execute: async () => {
          await fetch("https://mcp.example.com", {
            body: JSON.stringify({
              id: 42,
              jsonrpc: "2.0",
              method: "tools/call",
              params: { arguments: { issue: "ISSUE-1" }, name: "get_issue" },
            }),
            headers: { "mcp-protocol-version": "2025-11-25" },
            method: "POST",
          });
          return result;
        },
        protocolVersion: "2025-11-25",
        toolName: "get_issue",
      });
    });
    parent.end();
    await provider.forceFlush();

    const call = exporter.getFinishedSpans().find((span) => span.name === "tools/call get_issue");
    expect(call).toBeDefined();
    expect(call!.kind).toBe(SpanKind.CLIENT);
    expect(call!.ended).toBe(true);
    expect(call!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(call!.attributes).toMatchObject({
      "eve.connection.name": "linear",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.arguments": '{"issue":"ISSUE-1"}',
      "gen_ai.tool.call.result":
        '{"content":[{"text":"Issue title","type":"text"}],"isError":false}',
      "gen_ai.tool.name": "get_issue",
      "mcp.method.name": "tools/call",
      "mcp.protocol.version": "2025-11-25",
      "mcp.session.id": "session-1",
    });
    expectInjectedSpanContext(fetcher, call!.spanContext());
  });

  it("propagates and records the tools/list CLIENT span", async () => {
    const parent = runtimeTrace.getTracer("test.mcp").startSpan("parent");
    const fetcher = vi.fn(
      async (_request: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { headers: { "mcp-session-id": "session-2" } }),
    );
    const fetch = createMcpTraceFetch({
      connectionName: "linear",
      fetcher,
      getProtocolVersion: () => "2025-11-25",
    });

    await runtimeContext.with(runtimeTrace.setSpan(ROOT_CONTEXT, parent), async () => {
      await withMcpToolsListSpan({
        connectionName: "linear",
        execute: async () =>
          await fetch("https://mcp.example.com", {
            body: JSON.stringify({
              id: "list-1",
              jsonrpc: "2.0",
              method: "tools/list",
              params: {},
            }),
            headers: { "mcp-protocol-version": "2025-11-25" },
            method: "POST",
          }),
        protocolVersion: "2025-11-25",
      });
    });
    parent.end();
    await provider.forceFlush();

    const list = exporter.getFinishedSpans().find((span) => span.name === "tools/list");
    expect(list).toBeDefined();
    expect(list!.kind).toBe(SpanKind.CLIENT);
    expect(list!.ended).toBe(true);
    expect(list!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(list!.attributes).toMatchObject({
      "eve.connection.name": "linear",
      "jsonrpc.request.id": "list-1",
      "mcp.method.name": "tools/list",
      "mcp.protocol.version": "2025-11-25",
      "mcp.session.id": "session-2",
    });
    expectInjectedSpanContext(fetcher, list!.spanContext());
  });
});

function expectInjectedSpanContext(
  fetcher: ReturnType<typeof vi.fn>,
  spanContext: { readonly spanId: string; readonly traceId: string },
): void {
  const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  const requestBody = JSON.parse(String(requestInit?.body)) as {
    readonly params: { readonly _meta: Record<string, unknown> };
  };
  const traceparent = requestBody.params._meta["traceparent"];
  expect(typeof traceparent).toBe("string");
  const [, traceId, spanId] = String(traceparent).split("-");
  expect(traceId).toBe(spanContext.traceId);
  expect(spanId).toBe(spanContext.spanId);
}
