import {
  context as apiContext,
  trace as apiTrace,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentToolDescription } from "#channel/agent-description.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteChannelName,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mcpChannel } from "#public/channels/mcp.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { TraceCapturePolicy } from "#shared/trace-policy.js";
import { defineJsonSchema } from "#tools/schema.js";

// Content a tool sees or produces. It reaches a span only when content capture is on.
const SENTINEL = "sentinel-7f3a-content";
const CLIENT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CLIENT_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${CLIENT_TRACE_ID}-${CLIENT_SPAN_ID}-01`;
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

const log = createLogger("mcp-tools-tracing-test");
const inputJsonSchema = {
  additionalProperties: false,
  properties: { text: { type: "string" } },
  type: "object",
} as const;
const inputSchema = defineJsonSchema(inputJsonSchema);

function tool(name: string, execute: (input: { text?: string }) => unknown): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema,
    name,
  };
}

const tools = [
  tool(
    "lookup",
    async ({ text }) =>
      // A span the tool opens nests under the tool span.
      await apiTrace.getTracer("test.tool").startActiveSpan("nested lookup", async (span) => {
        span.end();
        return { echoed: text, status: "ok" };
      }),
  ),
  tool("explode", async ({ text }) => {
    // Logged failures record on the active span; their text must not be captured.
    logError(log, "the tool failed", new Error(`logged ${text}`));
    throw new Error(`thrown ${text}`);
  }),
];

const runtime: InvokeToolRuntime = {
  agentName: "compiled-agent",
  callbackBaseUrl: "https://agent.example",
  compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  manifest: {
    bindings: Object.fromEntries(
      tools.map(({ name }) => [`source:${name}`, { owner: { kind: "application" } } as never]),
    ),
    tools: tools.map(({ name }) => ({ hasExecute: true, name, sourceId: `source:${name}` })),
  },
  nodeId: "__root__",
  origin: { adapter: { kind: "mcp" } as never, agentName: "compiled-agent", channelName: "mcp" },
  sandboxRegistry: { sandbox: null } as never,
  tools: new Map(tools.map((definition) => [definition.name, definition])),
};

const descriptions: AgentToolDescription[] = tools.map(({ name }) => ({
  approval: false,
  description: name,
  inputSchema: inputJsonSchema,
  name,
}));

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function useTracing(tracePolicy?: TraceCapturePolicy, capturesContent = false): void {
  registerInstrumentationRuntime({
    forceFlush: async () => undefined,
    hooks: createInstrumentationHooks([]),
    otelSettings: {
      functionId: undefined,
      recordInputs: capturesContent,
      recordOutputs: capturesContent,
      traceChannelRequests: false,
      tracePolicy,
    },
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  });
}

beforeEach(() => {
  // Content is captured for a private audience only in development.
  vi.stubEnv("EVE_DEV", "1");
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  apiTrace.setGlobalTracerProvider(provider);
  useTracing();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await provider.shutdown();
  apiTrace.disable();
  apiContext.disable();
});

type Era = "2025" | "2026";

function callRequest(
  era: Era,
  name: string,
  meta: Readonly<Record<string, unknown>> = { traceparent: TRACEPARENT },
): Request {
  const params =
    era === "2026"
      ? {
          _meta: {
            ...meta,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          },
          arguments: { text: SENTINEL },
          name,
        }
      : { _meta: meta, arguments: { text: SENTINEL }, name };
  return new Request("https://agent.example/eve/v1/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "agent.example",
      ...(era === "2026"
        ? {
            "mcp-method": "tools/call",
            "mcp-name": name,
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          }
        : { "mcp-protocol-version": LEGACY_PROTOCOL_VERSION }),
    },
    method: "POST",
  });
}

async function call(request: Request): Promise<{ status: number; body: any }> {
  const channel = mcpChannel({ agent: false, auth: () => alice, tools: true });
  const post = channel.routes[1]!;
  if (post.transport === "websocket") throw new Error("expected HTTP route");
  const unavailable = () => {
    throw new Error("Route operation is unavailable in this test.");
  };
  const base: RouteHandlerArgs = {
    ...mockAgentRouteArgs(),
    attachSession: unavailable,
    describe: async () => ({ name: "compiled-agent", tools: descriptions }),
    from: unavailable,
    invokeTool: (name, input, options) => invokeTool(runtime, name, input, options),
    params: {},
    requestIp: "127.0.0.1",
    resolveSession: vi.fn(),
    to: unavailable,
    waitUntil: vi.fn(),
  };
  const args = attachRouteChannelName(
    attachAgentInfoRouteResponse(attachRouteSessionCreator(base, vi.fn()), async () =>
      Response.json({ agent: { name: "compiled-agent" } }),
    ),
    "mcp",
  );
  const response = await post.handler(request, args);
  const text = await response.text();
  if (response.status !== 200) throw new Error(`MCP answered ${response.status}: ${text}`);
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice("data: ".length)
    : text;
  return { body: JSON.parse(data), status: response.status };
}

function finished(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function toolSpan(name: string): ReadableSpan {
  const span = finished().find((candidate) => candidate.name === `execute_tool ${name}`);
  if (span === undefined) throw new Error(`no execute_tool span for ${name}`);
  return span;
}

function parentSpanId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

/** Everything an exporter would ship for a span, events and status included. */
function exported(span: ReadableSpan): string {
  return JSON.stringify({
    attributes: span.attributes,
    events: span.events,
    links: span.links,
    name: span.name,
    status: span.status,
  });
}

function expectNoContent(): void {
  for (const span of finished()) expect(exported(span)).not.toContain(SENTINEL);
}

describe.each<Era>(["2025", "2026"])("mcpChannel tool tracing over MCP %s", (era) => {
  it("parents a successful call on the client's trace and nests the tool's spans", async () => {
    const { body, status } = await call(callRequest(era, "lookup"));
    expect(status).toBe(200);
    expect(body.result.isError).toBeUndefined();

    const span = toolSpan("lookup");
    expect(span.spanContext().traceId).toBe(CLIENT_TRACE_ID);
    expect(parentSpanId(span)).toBe(CLIENT_SPAN_ID);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      "eve.channel.name": "mcp",
      "eve.tool.outcome": "completed",
      "gen_ai.agent.name": "compiled-agent",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "lookup",
      "gen_ai.tool.type": "function",
    });
    expect(span.attributes["gen_ai.tool.call.id"]).toMatch(/^call_/);
    expect(Object.values(span.attributes)).toContainEqual(expect.stringMatching(/^call_session_/));

    const nested = finished().find((candidate) => candidate.name === "nested lookup")!;
    expect(nested.spanContext().traceId).toBe(CLIENT_TRACE_ID);
    expect(parentSpanId(nested)).toBe(span.spanContext().spanId);
    expectNoContent();
  });
});

describe("mcpChannel tool trace context", () => {
  it.each([
    ["malformed", { traceparent: "not-a-traceparent" }],
    ["all-zero", { traceparent: `00-${"0".repeat(32)}-${CLIENT_SPAN_ID}-01` }],
    ["oversized", { traceparent: `${TRACEPARENT}${"0".repeat(4096)}` }],
    ["non-string", { traceparent: 42 }],
  ])("ignores a %s traceparent", async (_label, meta) => {
    await call(callRequest("2026", "lookup", meta));
    const span = toolSpan("lookup");
    expect(span.spanContext().traceId).not.toBe(CLIENT_TRACE_ID);
    expect(parentSpanId(span)).toBeUndefined();
  });

  it("keeps a bounded tracestate and drops an oversized one", async () => {
    await call(callRequest("2026", "lookup", { traceparent: TRACEPARENT, tracestate: "vendor=a" }));
    expect(toolSpan("lookup").parentSpanContext?.traceState?.get("vendor")).toBe("a");

    exporter.reset();
    const oversized = `vendor=${"a".repeat(600)}`;
    await call(callRequest("2026", "lookup", { traceparent: TRACEPARENT, tracestate: oversized }));
    const span = toolSpan("lookup");
    expect(parentSpanId(span)).toBe(CLIENT_SPAN_ID);
    expect(span.parentSpanContext?.traceState).toBeUndefined();
  });

  it("never lets MCP baggage choose the audience or content capture", async () => {
    const seen: string[] = [];
    useTracing((trace) => {
      seen.push(trace.audience);
      return { emit: true, recordInputs: true, recordOutputs: true };
    });
    await call(callRequest("2026", "lookup"));
    await call(
      callRequest("2026", "lookup", {
        baggage: "eve.audience=public,eve.parent_session=attacker,eve.conversation.id=x",
        traceparent: TRACEPARENT,
      }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    for (const span of finished()) {
      expect(JSON.stringify(span.attributes)).not.toContain("attacker");
    }
    // The policy allows content, but the declaration does not capture it.
    expectNoContent();
  });
});

describe("invokeTool trace policy", () => {
  it("emits no spans, nested ones included, when tracePolicy opts out", async () => {
    useTracing(() => false);
    await call(callRequest("2026", "lookup"));
    expect(finished()).toEqual([]);
  });

  it("keeps a failing tool's text off an existing parent span when no span is emitted", async () => {
    useTracing(() => false);
    const parent = apiTrace.getTracer("test.parent").startSpan("platform request");
    await apiContext.with(apiTrace.setSpan(apiContext.active(), parent), () =>
      invokeTool(runtime, "explode", { text: SENTINEL }, { auth: alice }),
    );
    (parent as Span).end();
    expect(finished().map((span) => span.name)).toEqual(["platform request"]);
    expectNoContent();
  });

  it("keeps a throwing tracePolicy's text off an existing parent span", async () => {
    useTracing(() => {
      throw new Error(`policy ${SENTINEL}`);
    });
    const parent = apiTrace.getTracer("test.parent").startSpan("platform request");
    const result = await apiContext.with(apiTrace.setSpan(apiContext.active(), parent), () =>
      invokeTool(runtime, "lookup", { text: "plain" }, { auth: alice }),
    );
    (parent as Span).end();
    expect(result).toMatchObject({ status: "completed" });
    expect(finished().map((span) => span.name)).toEqual(["platform request"]);
    expect(finished()[0]!.status.code).not.toBe(SpanStatusCode.ERROR);
    expectNoContent();
  });

  it("keeps a failing tool's text off an existing parent span with tracing undeclared", async () => {
    registerInstrumentationRuntime({
      forceFlush: async () => undefined,
      hooks: createInstrumentationHooks([]),
      otelSettings: undefined,
      runInContext: (_operation, execute) => execute(),
      shutdown: async () => undefined,
    });
    const parent = apiTrace.getTracer("test.parent").startSpan("platform request");
    const result = await apiContext.with(apiTrace.setSpan(apiContext.active(), parent), () =>
      invokeTool(runtime, "explode", { text: SENTINEL }, { auth: alice }),
    );
    (parent as Span).end();
    expect(result).toMatchObject({ status: "failed" });
    expect(finished().map((span) => span.name)).toEqual(["platform request"]);
    expectNoContent();
  });
});

describe("invokeTool content capture", () => {
  const record = { emit: true, recordInputs: true, recordOutputs: true } as const;

  it("records outputs without inputs when only outputs are allowed", async () => {
    useTracing(() => ({ emit: true, recordInputs: false, recordOutputs: true }), true);
    await invokeTool(runtime, "lookup", { text: SENTINEL }, { auth: alice });
    const span = toolSpan("lookup");
    expect(span.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(span.attributes["gen_ai.tool.call.result"]).toBeDefined();
  });

  it("records neither when the OpenTelemetry declaration turns content off", async () => {
    useTracing(() => record, false);
    await invokeTool(runtime, "lookup", { text: SENTINEL }, { auth: alice });
    const span = toolSpan("lookup");
    expect(span.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(span.attributes["gen_ai.tool.call.result"]).toBeUndefined();
    expectNoContent();
  });

  it("keeps a recorded failure's error off an existing parent span", async () => {
    useTracing(() => record, true);
    const parent = apiTrace.getTracer("test.parent").startSpan("platform request");
    await apiContext.with(apiTrace.setSpan(apiContext.active(), parent), () =>
      invokeTool(runtime, "explode", { text: SENTINEL }, { auth: alice }),
    );
    (parent as Span).end();

    expect(toolSpan("explode").status.message).toBe(`thrown ${SENTINEL}`);
    const parentSpan = finished().find((candidate) => candidate.name === "platform request")!;
    expect(exported(parentSpan)).not.toContain(SENTINEL);
  });
});
