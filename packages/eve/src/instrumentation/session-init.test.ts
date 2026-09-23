import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ModeKey,
  OtelTraceEnabledKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import { initializeSessionInstrumentation } from "#instrumentation/session-init.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
});

function createRuntime(tracePolicy: TraceCapturePolicy): InstrumentationRuntime {
  return {
    forceFlush: async () => undefined,
    hooks: { capturesContent: true, publish: async () => undefined },
    otelSettings: {
      recordInputs: true,
      recordOutputs: true,
      tracePolicy,
      traceChannelRequests: false,
    },
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  };
}

describe("initializeSessionInstrumentation", () => {
  it("reconstructs a legacy conversation from session context", () => {
    vi.stubEnv("EVE_DEV", "1");
    registerInstrumentationRuntime({
      ...createRuntime(
        ({ environment, principalType }) =>
          environment === "development" && principalType === "service",
      ),
      idGenerator: new AgentSpanIdGenerator(),
      prepareSessionTrace: async () => ({ spanId: "", traceFlags: 0, traceId: "" }),
    });
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, { kind: "channel:test", metadata: {} });
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      principalId: "service-1",
      principalType: "service",
    });
    ctx.set(ModeKey, "task");

    initializeSessionInstrumentation({ agentName: "test-agent", ctx });

    expect(ctx.get(SessionTraceSeedKey)?.decision).toMatchObject({ action: "record" });
    expect(ctx.get(OtelTraceEnabledKey)).toBe(false);
  });
});
