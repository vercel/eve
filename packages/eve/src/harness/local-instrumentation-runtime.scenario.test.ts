import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import type { InstrumentationAttemptScope } from "#harness/instrumentation-lifecycle.js";
import { installLocalInstrumentationRuntime } from "#harness/local-instrumentation-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("local instrumentation runtime", () => {
  it("persists agent, AI, and user spans in one trace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-"));
    temporaryDirectories.push(appRoot);
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

    await contextStorage.run(new ContextContainer(), async () => {
      await runtime.hooks.publish({
        agentName: "weather",
        rootSessionId: "session-1",
        sessionId: "session-1",
        type: "session.started",
      });
      await runtime.hooks.publish({
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
      const bridge = createAiSdkHookBridge(scope, runtime.hooks, runtime.runInContext);
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
        { callId: "call-1", modelId: "model-1", provider: "test", tools: undefined },
      ]);
      await bridge.executeLanguageModelCall!({
        callId: "call-1",
        execute: async () => {
          const span = trace.getTracer("test-user").startSpan("user.model-work");
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
      await Reflect.apply(bridge.onToolExecutionStart!, bridge, [
        {
          callId: "call-1",
          toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather" },
        },
      ]);
      await bridge.executeTool!({
        callId: "call-1",
        execute: async () => {
          const span = trace.getTracer("test-user").startSpan("user.tool-work");
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
      await runtime.hooks.publish({ scope, type: "attempt.completed" });
    });
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
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "agent.turn",
        "agent.step",
        "ai.streamText",
        "ai.streamText.doStream",
        "agent.action",
        "ai.toolCall",
        "user.model-work",
        "user.tool-work",
      ]),
    );
    expect(span(spans, "ai.streamText").parentSpanId).toBe(span(spans, "agent.step").spanId);
    expect(span(spans, "ai.streamText.doStream").parentSpanId).toBe(
      span(spans, "ai.streamText").spanId,
    );
    expect(span(spans, "user.model-work").parentSpanId).toBe(
      span(spans, "ai.streamText.doStream").spanId,
    );
    expect(span(spans, "agent.action").parentSpanId).toBe(span(spans, "agent.step").spanId);
    expect(span(spans, "ai.toolCall").parentSpanId).toBe(span(spans, "agent.action").spanId);
    expect(span(spans, "user.tool-work").parentSpanId).toBe(span(spans, "ai.toolCall").spanId);
  });
});

interface OtlpSpan {
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
