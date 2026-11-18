import { instrumentationScope } from "#instrumentation/scope.js";
import { APICallError, generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey } from "#context/keys.js";
import { bindInstrumentationRuntime } from "#instrumentation/runtime.js";
import { AgentSpanIdGenerator } from "#compiled/@vercel/agent-runs/index.js";
import { ConversationContextKey } from "#shared/conversation-context.js";

import {
  createInstrumentationHooks as createUnboundInstrumentationHooks,
  modelCallIdempotencyKey,
  type InstrumentationScope,
  type InstrumentationModelCallStartedEvent,
  type InstrumentationModelCallTerminalEvent,
  type InstrumentationEvent,
} from "#instrumentation/lifecycle.js";
import { createAiSdkHookBridge } from "#instrumentation/ai-sdk-hook-bridge.js";

const scope: InstrumentationScope = instrumentationScope(
  {
    runId: "turn-1:step-0:attempt-0",
    attempt: 0,
    sessionId: "session-1",
    turnId: "turn-1",
  },
  0,
);

describe("AI SDK model-call retry telemetry", () => {
  it("restarts instrumentation when generateText retries without another call-start callback", async () => {
    const started: InstrumentationModelCallStartedEvent[] = [];
    const terminal: InstrumentationModelCallTerminalEvent[] = [];
    const hooks = createUnboundInstrumentationHooks([
      {
        events: {
          "model.call.settled": (event) => void terminal.push(event),

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
          providerMetadata: { gateway: { cost: "0.01", generationId: "generation-1" } },
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
        outcome: "failed",
        error: expect.any(APICallError),
        idempotencyKey: modelCallIdempotencyKey(scope, 0, 0),
        type: "model.call.settled",
      },
      {
        outcome: "completed",
        finishReason: "stop",
        providerMetadata: { gateway: { cost: "0.01", generationId: "generation-1" } },
        idempotencyKey: modelCallIdempotencyKey(scope, 0, 1),
        type: "model.call.settled",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
  });
});

describe("AI SDK provider metadata under a content-free trace policy", () => {
  it("keeps the gateway's cost, generation id and routing when the SDK filters them out", async () => {
    const published: InstrumentationEvent[] = [];
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, { kind: "channel:test", metadata: {} });
    ctx.set(ConversationContextKey, {
      audience: "private",
      channel: { kind: "channel:test", name: "test" },
      environment: "production",
      principalType: "anonymous",
    });
    const instrumentation = bindInstrumentationRuntime(
      {
        forceFlush: async () => undefined,
        hooks: { capturesContent: false, publish: async (event) => void published.push(event) },
        idGenerator: new AgentSpanIdGenerator(),
        otelSettings: undefined,
        runInContext: (_operation, execute) => execute(),
        shutdown: async () => undefined,
      },
      ctx,
      { agentName: "test-agent", rootSessionId: "session-1", sessionId: "session-1" },
    );
    const gateway = {
      cost: "0.0421",
      generationId: "gen_1",
      marketCost: "0.05",
      routing: { clientSessionId: "conversation-1", finalProvider: "anthropic", secret: "x" },
      secret: "hidden",
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ text: "Done.", type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
        providerMetadata: { gateway },
      }),
    });

    await instrumentation?.prepareExecution().runStep(
      {
        environment: "test",
        eveVersion: "0.0.0",
        hasInput: true,
        session: { sessionId: "session-1" },
      },
      async (step) => {
        const attempt = step.prepareAttempt({
          attempt: 0,
          runId: "run_0",
          stepIndex: 0,
          turnId: "turn-1",
        });
        expect(attempt.telemetry).toMatchObject({ recordInputs: false, recordOutputs: false });
        await generateText({
          model,
          onLanguageModelCallEnd: attempt.onLanguageModelCallEnd,
          prompt: "Summarize Bob's notes.",
          telemetry: attempt.telemetry,
        });
      },
    );

    expect(published.find((event) => event.type === "model.call.settled")).toEqual(
      expect.objectContaining({
        outcome: "completed",
        providerMetadata: {
          gateway: {
            cost: "0.0421",
            generationId: "gen_1",
            marketCost: "0.05",
            routing: { clientSessionId: "conversation-1", finalProvider: "anthropic" },
          },
        },
      }),
    );
  });
});
