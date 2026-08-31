import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT_CONTEXT, trace as apiTrace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import {
  ROOT_CONTEXT as COMPILED_ROOT_CONTEXT,
  context as runtimeContext,
  trace as runtimeTrace,
} from "#compiled/@opentelemetry/api/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { createAiSdkHookBridge } from "#instrumentation/ai-sdk-hook-bridge.js";
import { listLocalTraces } from "#tracing/local-trace-reader.js";
import type { InstrumentationAttemptScope } from "#instrumentation/lifecycle.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#instrumentation/lifecycle.js";
import { installLocalInstrumentationRuntime } from "#tracing/local-instrumentation-runtime.js";
import { LocalTraceSpanProcessor } from "#tracing/local-trace-span-processor.js";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("local instrumentation runtime", () => {
  it("persists the agent trace hierarchy in OTLP segments", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-"));
    temporaryDirectories.push(appRoot);
    // Resolve and cache the public API tracer before eve installs its vendored
    // provider, matching an authored module's normal module-scope setup.
    const authoredTracer = (
      require("@opentelemetry/api") as typeof import("@opentelemetry/api")
    ).trace.getTracer("test-user");
    const runtime = installLocalInstrumentationRuntime({
      appRoot,
      frameworkVersion: "test",
      serviceName: "test-agent",
    });
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      functionId: "weather",
      rootSessionId: "session-1",
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const delivery = runtimeTrace.getTracer("workflow").startSpan("workflow.delivery");
    const activeContext = runtimeTrace.setSpan(COMPILED_ROOT_CONTEXT, delivery);
    const hooks = runtime.hooks.forTrace!({ agentName: "weather", audience: "unknown" });

    const exerciseRuntime = async () => {
      await hooks.publish({
        agentName: "weather",
        idempotencyKey: sessionIdempotencyKey("session-1"),
        rootSessionId: "session-1",
        sessionId: "session-1",
        type: "session.started",
      });
      await hooks.publish({
        idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
      const bridge = createAiSdkHookBridge(scope, hooks, runtime.runInContext);
      Reflect.apply(bridge.onStart!, bridge, [
        {
          callId: "call-1",
          modelId: "model-1",
          operationId: "ai.streamText",
          provider: "test",
        },
      ]);
      await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
      await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
        {
          callId: "call-1",
          messages: [],
          modelId: "model-1",
          provider: "test",
          tools: undefined,
        },
      ]);
      await bridge.executeLanguageModelCall!({
        callId: "call-1",
        execute: async () => {
          const span = authoredTracer.startSpan("user.model-work");
          expect(span.isRecording()).toBe(true);
          await Promise.resolve();
          span.end();
        },
      });
      await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
        {
          callId: "call-1",
          content: [],
          finishReason: "stop",
          performance: { responseTimeMs: 1 },
          responseId: "response-1",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]);
      const actionKey = actionIdempotencyKey("session-1", "turn-1", "tool-1");
      await hooks.publish({
        callId: "tool-1",
        idempotencyKey: actionKey,
        input: {},
        kind: "tool-call",
        name: "weather",
        scope,
        type: "action.started",
      });
      await Reflect.apply(bridge.onToolExecutionStart!, bridge, [
        {
          callId: "call-1",
          toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather" },
        },
      ]);
      await bridge.executeTool!({
        callId: "call-1",
        execute: async () => {
          const span = authoredTracer.startSpan("user.tool-work");
          expect(span.isRecording()).toBe(true);
          await Promise.resolve();
          span.end();
        },
        toolCallId: "tool-1",
      });
      await Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
        {
          callId: "call-1",
          messages: [],
          toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather" },
          toolExecutionMs: 1,
          toolOutput: { output: { temperature: 72 }, type: "tool-result" },
        },
      ]);
      await hooks.publish({
        idempotencyKey: actionKey,
        outcome: "completed",
        output: { output: { temperature: 72 }, type: "result" },
        scope,
        type: "action.completed",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
      await hooks.publish({
        idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.completed",
      });
      // Settling the turn emits the turn span with the pre-allocated id.
      await hooks.publish({
        idempotencyKey: sessionIdempotencyKey("session-1"),
        sessionId: "session-1",
        turnId: "turn-1",
        type: "session.waiting",
      });
    };
    await runtimeContext.with(activeContext, () =>
      contextStorage.run(new ContextContainer(), exerciseRuntime),
    );
    delivery.end();
    await runtime.forceFlush();

    const traceRoot = join(appRoot, ".eve", "traces", "v1");
    const [traceId] = await readdir(traceRoot);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/u);
    const segmentRoot = join(traceRoot, traceId!, "segments");
    const segments = await readdir(segmentRoot);
    const spanGroups = await Promise.all(
      segments.map(async (file) => {
        const payload = JSON.parse(await readFile(join(segmentRoot, file), "utf8")) as OtlpRequest;
        return payload.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scopeSpans) => scopeSpans.spans),
        );
      }),
    );
    const spans = spanGroups.flat();
    expect(formatTraceTree(spans)).toEqual([
      "agent.session",
      "  invoke_agent weather",
      "    agent.step",
      "      agent.action",
      "        execute_tool weather",
      "          user.tool-work",
      "      chat model-1",
      "        user.model-work",
    ]);
    expect(span(spans, "agent.step").links).toEqual([
      expect.objectContaining({
        attributes: expect.arrayContaining([
          expect.objectContaining({
            key: "eve.link.type",
            value: { stringValue: "workflow.delivery" },
          }),
        ]),
        spanId: delivery.spanContext().spanId,
        traceId: delivery.spanContext().traceId,
      }),
    ]);
    const listed = await listLocalTraces(appRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sessionId: "session-1", traceId });
  });

  it("keeps segments from overlapping worker writers", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-workers-"));
    temporaryDirectories.push(appRoot);
    const firstProcessor = new LocalTraceSpanProcessor(appRoot);
    const secondProcessor = new LocalTraceSpanProcessor(appRoot);
    const firstProvider = new BasicTracerProvider({ spanProcessors: [firstProcessor] });
    const secondProvider = new BasicTracerProvider({ spanProcessors: [secondProcessor] });
    const parent = apiTrace.setSpan(
      ROOT_CONTEXT,
      apiTrace.wrapSpanContext({
        spanId: "b".repeat(16),
        traceFlags: 1,
        traceId: "a".repeat(32),
      }),
    );

    firstProvider.getTracer("worker-1").startSpan("worker.one", {}, parent).end();
    secondProvider.getTracer("worker-2").startSpan("worker.two", {}, parent).end();
    await Promise.all([firstProcessor.forceFlush(), secondProcessor.forceFlush()]);

    const segments = await readdir(
      join(appRoot, ".eve", "traces", "v1", "a".repeat(32), "segments"),
    );
    expect(segments).toHaveLength(2);
  });
});

interface OtlpSpan {
  readonly links?: ReadonlyArray<{
    readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
    readonly spanId: string;
    readonly traceId: string;
  }>;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly spanId: string;
}

interface OtlpRequest {
  readonly resourceSpans: ReadonlyArray<{
    readonly scopeSpans: ReadonlyArray<{
      readonly spans: ReadonlyArray<OtlpSpan>;
    }>;
  }>;
}

function span(spans: readonly OtlpSpan[], name: string): OtlpSpan {
  return spans.find((candidate) => candidate.name === name)!;
}

function formatTraceTree(spans: readonly OtlpSpan[]): string[] {
  const children = Map.groupBy(spans, (candidate) => candidate.parentSpanId);
  const lines: string[] = [];
  const visited = new Set<string>();

  const append = (current: OtlpSpan, depth: number): void => {
    visited.add(current.spanId);
    lines.push(`${"  ".repeat(depth)}${current.name}`);
    for (const child of (children.get(current.spanId) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      append(child, depth + 1);
    }
  };

  for (const root of (children.get(undefined) ?? []).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    append(root, 0);
  }
  for (const orphan of spans.filter((candidate) => !visited.has(candidate.spanId))) {
    lines.push(`[orphan parent=${orphan.parentSpanId ?? "none"}] ${orphan.name}`);
  }
  return lines;
}
