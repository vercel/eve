import { context as apiContext, trace as apiTrace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineJsonSchema } from "#tools/schema.js";
import { AgentTraceSpanProcessor } from "#tracing/local/agent-trace-span-processor.js";

const CLIENT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

const inputSchema = defineJsonSchema({
  additionalProperties: false,
  properties: { text: { type: "string" } },
  type: "object",
} as const);

let openGate: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();
const seenActive: boolean[] = [];

function tool(name: string, execute: (input: { text?: string }) => unknown): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema,
    name,
  };
}

const tools = [
  tool("lookup", async () => {
    const traceId = apiTrace.getActiveSpan()?.spanContext().traceId;
    seenActive.push(traceId !== undefined && processor.activeTraceIds().has(traceId));
    await apiTrace.getTracer("test.tool").startActiveSpan("nested lookup", async (span) => {
      span.end();
    });
    return { status: "ok" };
  }),
  tool("gated", async () => {
    await gate;
    return { status: "ok" };
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

let exporter: InMemorySpanExporter;
let processor: AgentTraceSpanProcessor;
let provider: BasicTracerProvider;

beforeEach(() => {
  seenActive.length = 0;
  exporter = new InMemorySpanExporter();
  // The production local-trace processor: it claims traces and releases completed ones on flush.
  processor = new AgentTraceSpanProcessor([new SimpleSpanProcessor(exporter)]);
  provider = new BasicTracerProvider({ spanProcessors: [processor] });
  apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  apiTrace.setGlobalTracerProvider(provider);
  registerInstrumentationRuntime({
    forceFlush: async () => {
      await processor.forceFlush();
      processor.releaseCompletedTraces();
    },
    hooks: createInstrumentationHooks([]),
    otelSettings: {
      functionId: undefined,
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: false,
      tracePolicy: undefined,
    },
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  });
});

afterEach(async () => {
  await provider.shutdown();
  apiTrace.disable();
  apiContext.disable();
});

function names(): string[] {
  return exporter
    .getFinishedSpans()
    .map((span: ReadableSpan) => span.name)
    .sort();
}

function underClientTrace<T>(run: () => Promise<T>): Promise<T> {
  const remote = apiTrace.wrapSpanContext({
    isRemote: true,
    spanId: "00f067aa0ba902b7",
    traceFlags: TraceFlags.SAMPLED,
    traceId: CLIENT_TRACE_ID,
  });
  return apiContext.with(apiTrace.setSpan(apiContext.active(), remote), run);
}

describe("invokeTool trace ownership", () => {
  it("holds the trace while the call runs and releases it when the call ends", async () => {
    await invokeTool(runtime, "lookup", {}, { auth: alice });
    expect(seenActive).toEqual([true]);
    expect(names()).toEqual(["execute_tool lookup", "nested lookup"]);
    expect(processor.activeTraceIds().size).toBe(0);
  });

  it("keeps a shared caller trace until the last concurrent call ends", async () => {
    gate = new Promise((resolve) => (openGate = resolve));
    const slow = underClientTrace(() => invokeTool(runtime, "gated", {}, { auth: alice }));
    await underClientTrace(() => invokeTool(runtime, "lookup", {}, { auth: alice }));
    expect(processor.activeTraceIds().has(CLIENT_TRACE_ID)).toBe(true);

    openGate();
    await slow;
    expect(processor.activeTraceIds().size).toBe(0);
    expect(names()).toEqual(["execute_tool gated", "execute_tool lookup", "nested lookup"]);
  });

  it("claims a caller trace again for each sequential call", async () => {
    await underClientTrace(() => invokeTool(runtime, "lookup", {}, { auth: alice }));
    await underClientTrace(() => invokeTool(runtime, "lookup", {}, { auth: alice }));
    expect(seenActive).toEqual([true, true]);
    expect(names()).toEqual([
      "execute_tool lookup",
      "execute_tool lookup",
      "nested lookup",
      "nested lookup",
    ]);
    expect(processor.activeTraceIds().size).toBe(0);
  });

  it("leaves a trace a conversation owns for the conversation to release", async () => {
    const turn = apiTrace.getTracer("test.turn").startSpan("agent.turn", {
      attributes: { "agent.run.id": "session-1", "gen_ai.conversation.id": "conversation-1" },
    });
    const traceId = turn.spanContext().traceId;
    await apiContext.with(apiTrace.setSpan(apiContext.active(), turn), () =>
      invokeTool(runtime, "lookup", {}, { auth: alice }),
    );
    expect(processor.activeTraceIds().has(traceId)).toBe(true);
    turn.end();
    processor.releaseCompletedTraces();
    expect(processor.activeTraceIds().size).toBe(0);
  });
});

describe("invokeTool trace identity", () => {
  const identity = (span: ReadableSpan) => ({
    conversation: span.attributes["gen_ai.conversation.id"],
    run: span.attributes["agent.run.id"],
  });

  it("gives each keyed call its own run and conversation, never the tool session id", async () => {
    await invokeTool(runtime, "lookup", {}, { auth: alice, key: "desk" });
    await invokeTool(runtime, "lookup", {}, { auth: alice, key: "desk" });

    const [first, second] = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "execute_tool lookup")
      .map(identity);
    expect(first!.run).toMatch(/^call_session_/u);
    expect(first!.conversation).toBe(first!.run);
    expect(second!.run).toMatch(/^call_session_/u);
    expect(second!.run).not.toBe(first!.run);
    expect(second!.conversation).not.toBe(first!.conversation);
    const recorded = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
    expect(recorded).not.toContain("tool_session_");
  });
});
