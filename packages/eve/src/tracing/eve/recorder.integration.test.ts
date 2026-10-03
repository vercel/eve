import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTraceRecorder } from "#tracing/lib/index.js";
import { durableOtelBackend } from "./otel.js";
import { aiSdkContentSerializer } from "./serialization.js";
import { AgentSpanIdGenerator } from "./otel-ids.js";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

const identity = {
  conversationId: "conversation",
  runId: "run",
  turnId: "turn",
  framework: { name: "custom", version: "1" },
};
const capture = { emit: true, recordInputs: false, recordOutputs: false };

function setup() {
  const idGenerator = new AgentSpanIdGenerator();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const output = durableOtelBackend({
    tracer: provider.getTracer("recorder"),
    idGenerator,
    samplesTrace: () => true,
  });
  return {
    provider,
    exporter,
    recorder: createTraceRecorder({ output, serializer: aiSdkContentSerializer }),
  };
}

describe("trace recorder", () => {
  it("persists terminal outcome and accumulated usage without host record reconstruction", async () => {
    const runtime = setup();
    try {
      const turn = await runtime.recorder.turn({
        identity,
        metadata: { sequence: 0 },
        capture,
        operationId: "checkpoint",
      });
      const snapshot = runtime.recorder.checkpoint(turn.snapshot(), {
        terminal: { outcome: "failed", failed: true, error: new TypeError("private") },
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      const resumed = await runtime.recorder.resume(JSON.parse(JSON.stringify(snapshot)));
      await resumed?.complete();
      const [span] = runtime.exporter.getFinishedSpans();
      expect(span?.attributes).toMatchObject({
        "agent.turn.outcome": "failed",
        "error.type": "TypeError",
        "agent.usage.input_tokens": 3,
        "agent.usage.output_tokens": 2,
      });
      expect(JSON.stringify(span?.attributes)).not.toContain("private");
      expect(JSON.stringify(snapshot)).not.toContain("private");
    } finally {
      await runtime.provider.shutdown();
    }
  });
  it("snapshots operations and completes abandoned children before their parent", async () => {
    const runtime = setup();
    try {
      const turn = await runtime.recorder.turn({
        identity,
        metadata: { sequence: 0 },
        capture,
        operationId: "snapshots",
      });
      const attempt = await runtime.recorder.attempt({
        identity,
        capture,
        operationId: "step",
        parent: turn.reference,
        step: { index: 0 },
      });
      const action = await attempt.modelCall({ provider: "provider", modelId: "model" });
      const snapshot = JSON.parse(JSON.stringify(action.snapshot()));
      const restored = await runtime.recorder.resume(snapshot);
      expect(restored?.reference).toEqual(action.reference);
      expect(restored?.startTimeMs).toBe(action.startTimeMs);
      const recoveredTurn = await runtime.recorder.resume(
        JSON.parse(JSON.stringify(attempt.snapshot())),
      );
      await recoveredTurn?.complete();
      const spans = runtime.exporter.getFinishedSpans();
      expect(spans.map((span) => span.name)).toEqual(["chat model", "agent.step"]);
      expect(spans[0]!.parentSpanContext?.spanId).toBe(attempt.reference.spanId);
      await turn.complete();
      await attempt.complete();
      const finished = await runtime.recorder.resume(attempt.snapshot());
      await finished?.complete();
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(5);
    } finally {
      await runtime.provider.shutdown();
    }
  });
  it("resumes a pending tool result in another recorder before attaching its parent", async () => {
    const idGenerator = new AgentSpanIdGenerator();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const output = durableOtelBackend({
      tracer: provider.getTracer("pending-resume"),
      idGenerator,
      samplesTrace: () => true,
    });
    const options = { output, serializer: aiSdkContentSerializer };
    try {
      const before = createTraceRecorder(options);
      const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
      const pending = await before.pendingTool({
        identity,
        key: "execution",
        callId: "call",
        name: "lookup",
        parent,
        capture,
      });
      const reference = pending.reference;
      await pending.complete({ outcome: "completed", output: "private" });
      const after = createTraceRecorder(options);
      const restored = (await after.resumeTool(JSON.parse(JSON.stringify(pending.snapshot()))))!;
      await restored.attach({ ...parent, spanId: "c".repeat(16) });
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.spanContext().spanId).toBe(reference.spanId);
      expect(spans[0]!.parentSpanContext?.spanId).toBe("c".repeat(16));
      expect(JSON.stringify(spans[0]!.attributes)).not.toContain("private");
      const completed = (await after.resumeTool(JSON.parse(JSON.stringify(restored.snapshot()))))!;
      await completed.attach(parent);
      await completed.drain();
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    } finally {
      await provider.shutdown();
    }
  });
  it("executes once and preserves errors after live span setup fails", async () => {
    const idGenerator = new AgentSpanIdGenerator();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const backend = durableOtelBackend({
      tracer: provider.getTracer("failure"),
      idGenerator,
      samplesTrace: () => true,
    });
    backend.startReserved = () => {
      throw new Error("span setup");
    };
    const recorder = createTraceRecorder({
      output: backend,
      serializer: aiSdkContentSerializer,
    });
    try {
      const turn = await recorder.attempt({
        identity,
        step: { index: 0 },
        capture,
        operationId: "failure",
        parent: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 },
      });
      let executions = 0;
      const result = turn.run(() => {
        executions++;
        return "original";
      });
      expect(result).toBe("original");
      expect(executions).toBe(1);
      const error = new TypeError("original failure");
      await expect(
        turn.run(async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      await turn.complete({ outcome: "completed" });
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      await provider.shutdown();
    }
  });
  it("rejects corrupt checkpoint records without starting spans", async () => {
    const runtime = setup();
    try {
      const result = await runtime.recorder.resume({ key: "invalid" });
      expect(result).toBeUndefined();
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      await runtime.provider.shutdown();
    }
  });

  it("retains pending tool enrichment and terminal state until its action parent attaches", async () => {
    const runtime = setup();
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      const recorder = runtime.recorder;
      const parent = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
      const action = { ...parent, spanId: "3".repeat(16) };
      const pending = await recorder.pendingTool({
        identity,
        key: "tool",
        callId: "call",
        name: "lookup",
        parent,
        capture,
      });
      const operation = pending;
      operation.run(() =>
        recorder
          .active()
          ?.mcp?.update({ connectionName: "catalog", method: "tools/call", requestId: "7" }),
      );
      await pending.complete({ outcome: "completed", output: "secret" });
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(0);
      await pending.attach(action);
      const [span] = runtime.exporter.getFinishedSpans();
      expect(span?.parentSpanContext?.spanId).toBe(action.spanId);
      expect(span?.attributes["jsonrpc.request.id"]).toBe("7");
      expect(span?.spanContext().spanId).toBe(operation.reference.spanId);
      expect(JSON.stringify(span?.attributes)).not.toContain("secret");
      expect(pending.finished).toBe(true);
    } finally {
      context.disable();
      manager.disable();
      await runtime.provider.shutdown();
    }
  });

  it("inherits tracestate from resumed operations", async () => {
    const runtime = setup();
    try {
      const recorder = runtime.recorder;
      const reference = {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        traceFlags: 1,
        tracestate: "vendor=state",
      };
      const parent = { ...reference, spanId: "3".repeat(16), tracestate: "vendor=parent" };
      const attempt = await recorder.resume({
        version: 1,
        key: "attempt",
        identity,
        data: { type: "step", options: { index: 0 } },
        capture,
        reference,
        parent,
        startTimeMs: Date.now(),
      });
      if (attempt?.type !== "step") throw new Error("Expected restored attempt");
      const model = await attempt!.modelCall({ provider: "provider", modelId: "model" }, "model");
      await model.complete({ outcome: "completed", result: { finishReason: "stop", usage: {} } });
      await attempt!.complete({ outcome: "completed" });
      const spans = runtime.exporter.getFinishedSpans();
      const modelSpan = spans.find((span) => span.name === "chat model")!;
      expect(modelSpan.parentSpanContext?.spanId).toBe(reference.spanId);
      expect(modelSpan.parentSpanContext?.traceState?.serialize()).toBe("vendor=state");
      const step = spans.find((span) => span.name === "agent.step")!;
      expect(step.parentSpanContext?.traceState?.serialize()).toBe("vendor=parent");
      expect(step.spanContext().spanId).toBe(reference.spanId);
    } finally {
      await runtime.provider.shutdown();
    }
  });
});
