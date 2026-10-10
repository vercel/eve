import { APICallError, generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createInstrumentationHooks as createUnboundInstrumentationHooks,
  modelCallIdempotencyKey,
  type InstrumentationAttemptScope,
  type InstrumentationModelCallStartedEvent,
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
