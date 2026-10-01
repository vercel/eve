import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ParentTraceContextKey,
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
  it.each([0, 1])(
    "preserves the caller's trace and sampling flag %s at child creation",
    (traceFlags) => {
      const ctx = new ContextContainer();
      const parent = { spanId: "a".repeat(16), traceFlags, traceId: "b".repeat(32) };
      ctx.set(ParentTraceContextKey, parent);

      initializeSessionInstrumentation({ agentName: "child", ctx });

      const seed = ctx.get(SessionTraceSeedKey)!;
      expect(seed.traceId).toBe(parent.traceId);
      expect(seed.spanId).not.toBe(parent.spanId);
      expect(seed.traceFlags).toBe(traceFlags);
    },
  );

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

    initializeSessionInstrumentation({ agentName: "test-agent", ctx });

    expect(ctx.get(SessionTraceSeedKey)?.decision).toMatchObject({ action: "record" });
  });
});
