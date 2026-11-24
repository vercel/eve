import { instrumentationScope } from "#instrumentation/scope.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import { testEntities } from "#internal/testing/test-platform.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { otel, type TracePolicyDecision } from "#public/instrumentation/otel.js";

vi.mock("#tracing/eve/otel-registration.js", () => ({
  registerOtel: () => ({
    provider: { getTracer: () => ({}) },
    idGenerator: { deriveSpanId: () => "2".repeat(16), generateTraceId: () => "1".repeat(32) },
    samplesTrace: () => true,
    forceFlush: async () => {},
    shutdown: async () => {},
  }),
}));
const PROCESS_APP_KEY = Symbol.for("eve.app");
const platform = testEntities();

const traceContext = (audience: "public" | "private" | "unknown") => ({
  agentName: "weather-agent",
  audience,
  channel: { kind: "http" as const },
  environment: "production" as const,
  principalType: "anonymous",
});

describe("otel and authored provider composition", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[PROCESS_APP_KEY];
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
        platform,
        slot: "otel",
        value: otel({ tracePolicy: () => policy as TracePolicyDecision }),
      });
      await registerInstrumentationProvider({
        agentName: "weather-agent",
        platform,
        slot: "rows",
        value: defineInstrumentation({
          tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
          events: { "model.call.started": modelStarted },
        }),
      });
      const runtime = finalizeInstrumentationProviders({ platform, serviceName: "weather-agent" });
      const hooks = runtime.hooks.forTrace!(traceContext("private"));

      await contextStorage.run(new ContextContainer(), () =>
        hooks.publish({
          idempotencyKey: "model:session-1:turn-1:0:0:0",
          input: {
            instructions: "private instructions",
            messages: [{ content: "private user message", role: "user" }],
          },
          model: { modelId: "test-model", provider: "test-provider" },
          scope: instrumentationScope(
            {
              runId: "session-1:turn-1:0:0",
              attempt: 0,
              channelAudience: "private",
              sessionId: "session-1",
              turnId: "turn-1",
            },
            0,
          ),
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
