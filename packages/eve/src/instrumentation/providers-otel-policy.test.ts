import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { otel, type TracePolicyDecision } from "#public/instrumentation/otel.js";

vi.mock("#tracing/otel-registration.js", () => ({
  registerOtelPipeline: () => ({
    forceFlush: async () => undefined,
    idGenerator: {
      deriveSpanId: () => "2".repeat(16),
      generateTraceId: () => "1".repeat(32),
      withSpanId: (_spanId: string, run: () => unknown) => run(),
      withTraceId: (_traceId: string, run: () => unknown) => run(),
    },
    shutdown: async () => undefined,
  }),
}));

const REGISTRY_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");
const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

describe("otel and authored provider composition", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it.each([
    ["redacted", { emit: true, recordInputs: false, recordOutputs: false }],
    ["dropped", { emit: false }],
  ] as const)(
    "keeps content-provider events independent from a %s OTel trace",
    async (_name, policy) => {
      const modelStarted = vi.fn();
      await registerInstrumentationProvider({
        agentName: "weather-agent",
        slot: "otel",
        value: otel({ tracePolicy: () => policy as TracePolicyDecision }),
      });
      await registerInstrumentationProvider({
        agentName: "weather-agent",
        slot: "rows",
        value: defineInstrumentation({
          capture: "content",
          events: { "model.call.started": modelStarted },
        }),
      });
      const runtime = finalizeInstrumentationProviders({ serviceName: "weather-agent" });

      await contextStorage.run(new ContextContainer(), () =>
        runtime.hooks.publish({
          idempotencyKey: "model:session-1:turn-1:0:0:0",
          input: {
            instructions: "private instructions",
            messages: [{ content: "private user message", role: "user" }],
          },
          model: { modelId: "test-model", provider: "test-provider" },
          scope: {
            attemptId: "session-1:turn-1:0:0",
            attemptIndex: 0,
            channelAudience: "private",
            sessionId: "session-1",
            stepIndex: 0,
            turnId: "turn-1",
          },
          type: "model.call.started",
        }),
      );

      expect(modelStarted).toHaveBeenCalledOnce();
      expect(modelStarted.mock.calls[0]?.[0].input).toEqual({
        instructions: "private instructions",
        messages: [{ content: "private user message", role: "user" }],
      });
    },
  );
});
