import { APICallError, createGateway, generateText, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createInstrumentationHooks as createUnboundInstrumentationHooks,
  modelCallIdempotencyKey,
  type InstrumentationAttemptScope,
  type InstrumentationModelCallStartedEvent,
  type InstrumentationModelCallCompletedEvent,
  type InstrumentationModelCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { createAiSdkHookBridge } from "#instrumentation/ai-sdk-hook-bridge.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "turn-1:step-0:attempt-0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

describe("AI SDK model-call retry telemetry", () => {
  it("publishes Gateway stream identifiers even when no provider captures content", async () => {
    const completed: InstrumentationModelCallCompletedEvent[] = [];
    const hooks = createUnboundInstrumentationHooks([
      {
        events: { "model.call.completed": (event) => void completed.push(event) },
        name: "metadata",
        tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
      },
    ]).forTrace!({
      agentName: "test-agent",
      audience: "public",
      channel: { kind: "http" },
      environment: "production",
      principalType: "anonymous",
    });
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Sunny today." },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        providerMetadata: {
          gateway: { generationId: "gen_123", transcripts: { enabled: true } },
        },
      },
    ];
    const gateway = createGateway({
      apiKey: "gateway-test",
      fetch: async () =>
        new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const result = streamText({
      model: gateway.languageModel("openai/gpt-5.4-mini"),
      prompt: "Help Alice check today's weather.",
      telemetry: { integrations: [createAiSdkHookBridge(scope, hooks)], isEnabled: true },
    });
    await result.consumeStream();

    expect(await result.text).toBe("Sunny today.");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.gateway).toEqual({ generationId: "gen_123", transcriptsEnabled: true });
    expect(completed[0]!.content).toBeUndefined();
    expect(Object.isFrozen(completed[0]!.gateway)).toBe(true);
  });

  it("restarts instrumentation when generateText retries without another call-start callback", async () => {
    const started: InstrumentationModelCallStartedEvent[] = [];
    const terminal: InstrumentationModelCallTerminalEvent[] = [];
    const hooks = createUnboundInstrumentationHooks([
      {
        events: {
          "model.call.completed": (event) => void terminal.push(event),
          "model.call.failed": (event) => void terminal.push(event),
          "model.call.started": (event) => void started.push(event),
        },
        name: "retry",
        tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
      },
    ]).forTrace!({
      agentName: "test-agent",
      audience: "unknown",
      channel: { kind: "http" },
      environment: "production",
      principalType: "anonymous",
    });
    let providerAttempts = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        providerAttempts += 1;
        if (providerAttempts === 1) {
          throw new APICallError({
            isRetryable: true,
            message: "temporarily unavailable",
            requestBodyValues: {},
            statusCode: 503,
            url: "https://model.example/generate",
          });
        }
        return {
          content: [{ text: "Recovered answer.", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
            outputTokens: { reasoning: 0, text: 1, total: 1 },
          },
          warnings: [],
        };
      },
    });

    const contextKeys: string[] = [];
    const bridge = createAiSdkHookBridge(scope, hooks, (operation, execute) => {
      contextKeys.push(operation.idempotencyKey);
      return execute();
    });
    const result = await generateText({
      maxRetries: 1,
      model,
      prompt: "Answer Alice's question.",
      telemetry: { integrations: [bridge], isEnabled: true },
    });

    expect(result.text).toBe("Recovered answer.");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(started.map((event) => event.idempotencyKey)).toEqual([
      modelCallIdempotencyKey(scope, 0, 0),
      modelCallIdempotencyKey(scope, 0, 1),
    ]);
    expect(contextKeys).toEqual([
      modelCallIdempotencyKey(scope, 0, 0),
      modelCallIdempotencyKey(scope, 0, 1),
    ]);
    expect(terminal).toMatchObject([
      {
        error: expect.any(APICallError),
        idempotencyKey: modelCallIdempotencyKey(scope, 0, 0),
        type: "model.call.failed",
      },
      {
        finishReason: "stop",
        idempotencyKey: modelCallIdempotencyKey(scope, 0, 1),
        type: "model.call.completed",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
  });
});
