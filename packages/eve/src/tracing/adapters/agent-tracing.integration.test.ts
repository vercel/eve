import { APICallError, generateText, streamText, stepCountIs, tool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { context } from "@opentelemetry/api";
import { createAgentTracing } from "#tracing/core/agent-tracing.js";
import { liveOtelBackend, durableOtelBackend } from "#tracing/adapters/otel.js";
import { aiSdkTracing } from "#tracing/adapters/ai-sdk.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { createTraceEngine } from "#tracing/core/engine.js";
import { createDurableTraceDriver, type DurableSpanRecord } from "#tracing/core/durable.js";
import { createTransportTracing } from "#tracing/adapters/transports.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 3, total: 3 },
  outputTokens: { reasoning: 0, text: 2, total: 2 },
};
const providers: BasicTracerProvider[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
});

function setup(mapping = false) {
  const exporter = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  providers.push(provider);
  const tracer = provider.getTracer("agent-library-test");
  const backend = liveOtelBackend(
    tracer,
    mapping
      ? eveOutputMapping({
          resolve: () => ({ platform: "vercel", traceSessionId: "platform-session" }),
        })
      : undefined,
  );
  const tracing = createAgentTracing({
    agentName: "support",
    framework: { name: "custom", version: "1" },
    backend,
    serializer: aiSdkContentSerializer,
  });
  return { exporter, provider, tracer, backend, tracing, idGenerator };
}

describe("standalone agent tracing", () => {
  it("records an SDK tool loop with isolated async parents and no content by default", async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      const runtime = setup();
      const model = new MockLanguageModelV3({
        doGenerate: [
          {
            content: [
              { type: "tool-call", toolCallId: "lookup-1", toolName: "lookup", input: "{}" },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          },
          {
            content: [{ type: "text", text: "Private answer" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          },
        ],
      });
      const result = await runtime.tracing.turn(
        { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 },
        async (turn) => {
          return generateText({
            model,
            prompt: "Private question",
            stopWhen: stepCountIs(2),
            tools: {
              lookup: tool({
                inputSchema: jsonSchema({ type: "object", properties: {} }),
                execute: async () => {
                  await Promise.resolve();
                  const child = runtime.tracer.startSpan("database", {}, context.active());
                  child.end();
                  return "Private tool result";
                },
              }),
            },
            telemetry: aiSdkTracing(turn),
          });
        },
      );
      expect(result.text).toBe("Private answer");
      const spans = runtime.exporter.getFinishedSpans();
      const root = spans.find((span) => span.name === "invoke_agent support")!;
      const steps = spans.filter((span) => span.name === "agent.step");
      const models = spans.filter((span) => span.name.startsWith("chat "));
      const action = spans.find((span) => span.name === "agent.action")!;
      const executed = spans.find((span) => span.name === "execute_tool lookup")!;
      const database = spans.find((span) => span.name === "database")!;
      expect(steps).toHaveLength(2);
      expect(models).toHaveLength(2);
      expect(
        steps.every((span) => span.parentSpanContext?.spanId === root.spanContext().spanId),
      ).toBe(true);
      expect(
        models.every((span) =>
          steps.some((step) => span.parentSpanContext?.spanId === step.spanContext().spanId),
        ),
      ).toBe(true);
      expect(action.parentSpanContext?.spanId).toBe(steps[0]!.spanContext().spanId);
      expect(executed.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
      expect(database.parentSpanContext?.spanId).toBe(executed.spanContext().spanId);
      expect(root.attributes).toMatchObject({
        "agent.framework.name": "custom",
        "agent.trace.schema.version": 1,
        "gen_ai.usage.input_tokens": 6,
      });
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("Private");
      expect(
        spans.every((span) =>
          Object.keys(span.attributes).every(
            (key) => !key.startsWith("eve.") && key !== "vercel.session_id",
          ),
        ),
      ).toBe(true);
    } finally {
      context.disable();
      manager.disable();
    }
  });

  it("maps deferred spans and late updates without changing their reserved identity", async () => {
    const runtime = setup();
    const backend = durableOtelBackend({
      tracer: runtime.tracer,
      idGenerator: runtime.idGenerator,
      samplesTrace: () => true,
      mapping: eveOutputMapping({
        resolve: () => ({ platform: "vercel", traceSessionId: "platform-session" }),
      }),
    });
    const capture = { emit: true, recordInputs: false, recordOutputs: false };
    const span = {
      type: "activation" as const,
      operationId: "activation",
      name: "invoke_agent support",
      root: true,
      startTimeMs: 1000,
      attributes: { "agent.run.id": "run", "agent.trace.schema.version": 1 },
      links: [
        {
          context: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
          relationship: "agent.dispatch" as const,
        },
      ],
    };
    const reference = backend.reserveActivation({ key: "activation", span, capture });
    const engine = createTraceEngine({ backend });
    const childReference = backend.reserveChild(reference, "tool");
    const child = engine.startReserved(
      {
        type: "tool",
        operationId: "tool",
        name: "execute_tool lookup",
        parent: reference,
        attributes: { "agent.run.id": "run", "agent.trace.schema.version": 1 },
      },
      childReference,
      capture,
    );
    child.setAttribute("agent.connection.name", "catalog");
    child.end(2000);
    const records = new Map<string, DurableSpanRecord>();
    const store = {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: DurableSpanRecord) => {
        records.set(key, value);
      },
      delete: async (key: string) => {
        records.delete(key);
      },
    };
    const driver = createDurableTraceDriver({ backend, store });
    await driver.reserve("activation", span, capture);
    const resumed = createDurableTraceDriver({ backend, store });
    await resumed.finish("activation", { event: "turn.completed", endTimeMs: 3000 });
    const recorded = runtime.exporter.getFinishedSpans();
    expect(recorded[0]!.spanContext().spanId).toBe(childReference.spanId);
    expect(recorded[0]!.parentSpanContext?.spanId).toBe(reference.spanId);
    expect(recorded[0]!.attributes).toMatchObject({
      "eve.connection.name": "catalog",
      "vercel.session_id": "platform-session",
      "agent.trace.schema.version": 4,
    });
    expect(recorded[1]!.spanContext()).toMatchObject(reference);
    expect(recorded[1]!.links[0]!.attributes).toEqual({ "eve.link.type": "agent.dispatch" });
    expect(records.size).toBe(0);
  });

  it("counts successful physical retries once and records requested content", async () => {
    vi.useFakeTimers();
    const runtime = setup();
    const tracing = createAgentTracing({
      agentName: "support",
      framework: { name: "custom", version: "1" },
      backend: runtime.backend,
      serializer: aiSdkContentSerializer,
      content: { recordInputs: true, recordOutputs: true },
    });
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        if (++attempts === 1)
          throw new APICallError({
            message: "temporary",
            url: "https://model.example",
            requestBodyValues: {},
            statusCode: 503,
            isRetryable: true,
          });
        return {
          content: [{ type: "text", text: "Alice's answer" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const execution = tracing.turn(
      { conversationId: "conversation", runId: "run", turnId: "retry", sequence: 0 },
      (turn) =>
        generateText({
          model,
          prompt: "Alice's question",
          maxRetries: 1,
          telemetry: aiSdkTracing(turn),
        }),
    );
    await vi.runAllTimersAsync();
    await execution;
    const spans = runtime.exporter.getFinishedSpans();
    const calls = spans.filter((span) => span.name.startsWith("chat "));
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((span) => span.spanContext().spanId)).size).toBe(2);
    expect(calls[0]!.status.code).toBe(2);
    expect(calls[1]!.attributes["ai.response.text"]).toBe("Alice's answer");
    expect(calls[1]!.attributes["gen_ai.input.messages"]).toContain("Alice's question");
    expect(
      spans.find((span) => span.name === "invoke_agent support")!.attributes[
        "gen_ai.usage.input_tokens"
      ],
    ).toBe(3);
  });

  it("isolates parallel turn context and links only the first delegated activation", async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      const runtime = setup();
      const caller = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
      await Promise.all(
        [0, 1].map((sequence) =>
          runtime.tracing.turn(
            {
              conversationId: "conversation",
              runId: `run-${sequence}`,
              turnId: `turn-${sequence}`,
              sequence,
              caller,
            },
            async () => {
              await Promise.resolve();
              runtime.tracer.startSpan(`child-${sequence}`, {}, context.active()).end();
            },
          ),
        ),
      );
      const spans = runtime.exporter.getFinishedSpans();
      const roots = spans.filter((span) => span.name === "invoke_agent support");
      expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(2);
      for (const root of roots) {
        const sequence = root.attributes["agent.turn.sequence"];
        expect(
          spans.find((span) => span.name === `child-${sequence}`)!.parentSpanContext?.spanId,
        ).toBe(root.spanContext().spanId);
        expect(root.links).toHaveLength(sequence === 0 ? 1 : 0);
      }
    } finally {
      context.disable();
      manager.disable();
    }
  });

  it("records approval, memory, request, and MCP spans with directional capture", async () => {
    const runtime = setup(true);
    const tracing = createAgentTracing({
      agentName: "support",
      framework: { name: "custom", version: "1" },
      backend: runtime.backend,
      serializer: aiSdkContentSerializer,
      content: { recordInputs: true, recordOutputs: false },
    });
    await tracing.turn(
      { conversationId: "conversation", runId: "run", turnId: "auxiliary", sequence: 0 },
      async (turn) => {
        const operations = turn.operations;
        const step = operations.step(turn.activation, {
          operationId: "step",
          index: 0,
          attempt: 0,
        });
        const action = operations.action(step, {
          operationId: "action",
          callId: "call",
          name: "lookup",
          kind: "tool-call",
          stepIndex: 0,
          attempt: 0,
        });
        const approval = operations.approval(action, {
          operationId: "approval",
          callId: "call",
          actionName: "lookup",
          requestId: "request",
          stepIndex: 0,
          attempt: 0,
          request: { prompt: "Approve" },
        });
        operations.completeApproval(approval, {
          outcome: "approved",
          response: "private response",
        });
        const memory = operations.memory(action, {
          operationId: "memory",
          operation: "search_memory",
          phase: "retrieve",
          slot: "history",
          storeId: "store",
        });
        operations.completeMemory(memory, {
          recordCount: 1,
          records: [{ content: "Permitted record" }],
        });
        operations.completeAction(action, { outcome: "completed", output: "private output" });
        step.end();
      },
    );
    const transport = createTransportTracing(runtime.backend);
    await transport.request(
      { method: "POST", route: "/agents/:id", channelName: "http", channelKind: "http" },
      async () => ({ status: 503 }),
    );
    await transport.mcp(
      {
        method: "tools/list",
        connectionName: "catalog",
        capture: { emit: true, recordInputs: false, recordOutputs: false },
      },
      async () => [],
    );
    const spans = runtime.exporter.getFinishedSpans();
    const approval = spans.find((span) => span.name === "agent.approval")!;
    const memory = spans.find((span) => span.name === "search_memory")!;
    expect(approval.attributes["agent.approval.request"]).toContain("Approve");
    expect(approval.attributes["agent.approval.response"]).toBeUndefined();
    expect(memory.attributes["gen_ai.memory.records"]).toContain("Permitted record");
    expect(memory.parentSpanContext?.spanId).toBe(approval.parentSpanContext?.spanId);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("private");
    const request = spans.find((span) => span.name === "agent.channel.request")!;
    expect(request.attributes).toMatchObject({
      "eve.channel.name": "http",
      "http.route": "/agents/:id",
      "http.response.status_code": 503,
    });
    expect(request.attributes["error.type"]).toBeUndefined();
    expect(request.status.code).toBe(2);
    expect(
      spans.find((span) => span.name === "tools/list")!.attributes["eve.connection.name"],
    ).toBe("catalog");
  });

  it("reports cancellation without treating the activation as failure", async () => {
    const runtime = setup();
    const controller = new AbortController();
    const error = new Error("stopped");
    await expect(
      runtime.tracing.turn(
        {
          conversationId: "conversation",
          runId: "run",
          turnId: "cancel",
          sequence: 0,
          signal: controller.signal,
        },
        async () => {
          controller.abort();
          throw error;
        },
      ),
    ).rejects.toBe(error);
    const root = runtime.exporter.getFinishedSpans()[0]!;
    expect(root.attributes["agent.turn.outcome"]).toBe("cancelled");
    expect(root.status.code).not.toBe(2);
    expect(root.events.map((event) => event.name)).toEqual(["turn.started", "turn.cancelled"]);
  });

  it("keeps model spans open until streaming completes", async () => {
    const runtime = setup();
    let finishStream: (() => void) | undefined;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "answer" });
            controller.enqueue({ type: "text-delta", id: "answer", delta: "Answer" });
            finishStream = () => {
              controller.enqueue({ type: "text-end", id: "answer" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            };
          },
        }),
      }),
    });
    let text = "";
    await runtime.tracing.turn(
      { conversationId: "conversation", runId: "run", turnId: "stream", sequence: 0 },
      async (turn) => {
        const response = streamText({ model, prompt: "Help Alice", telemetry: aiSdkTracing(turn) });
        for await (const chunk of response.textStream) {
          text += chunk;
          expect(
            runtime.exporter.getFinishedSpans().some((span) => span.name.startsWith("chat ")),
          ).toBe(false);
          finishStream!();
        }
      },
    );
    expect(text).toBe("Answer");
    const spans = runtime.exporter.getFinishedSpans();
    expect(spans.filter((span) => span.name.startsWith("chat "))).toHaveLength(1);
    expect(
      spans.find((span) => span.name === "invoke_agent support")!.attributes[
        "gen_ai.usage.input_tokens"
      ],
    ).toBe(3);
  });
});
