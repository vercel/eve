import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, SessionTraceSeedKey } from "#context/keys.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { ensureSessionInstrumentationPlan } from "#instrumentation/migration.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { parseSessionInstrumentationPlan } from "#instrumentation/session-plan.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";

function runtime(tracePolicy: () => boolean): InstrumentationRuntime {
  return {
    forceFlush: async () => undefined,
    hooks: createInstrumentationHooks([]),
    idGenerator: new AgentSpanIdGenerator(),
    otelSettings: {
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: false,
      tracePolicy,
    },
    prepareSessionTrace: async () => ({ spanId: "", traceFlags: 0, traceId: "" }),
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  };
}

describe("ensureSessionInstrumentationPlan", () => {
  it("preserves an existing seed exactly without evaluating policy", () => {
    const tracePolicy = vi.fn(() => false);
    const ctx = new ContextContainer();
    const seed = {
      spanId: "1111111111111111",
      traceFlags: 1,
      traceId: "22222222222222222222222222222222",
    };
    ctx.set(SessionTraceSeedKey, seed);
    ctx.set(ChannelInstrumentationKey, {
      channelType: "web",
      kind: "channel:web",
      metadata: { audience: "private" },
    });

    const plan = ensureSessionInstrumentationPlan({
      agentName: "test-agent",
      ctx,
      rootSessionId: "session-1",
      runtime: runtime(tracePolicy),
    });

    expect(parseSessionInstrumentationPlan(plan)).toMatchObject(seed);
    expect(tracePolicy).not.toHaveBeenCalled();
  });

  it("evaluates policy once when no seed exists and freezes classification", () => {
    const tracePolicy = vi.fn(() => true);
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      channelType: "web",
      kind: "channel:web",
      metadata: { audience: "public" },
    });
    const installedRuntime = runtime(tracePolicy);

    const first = ensureSessionInstrumentationPlan({
      agentName: "test-agent",
      ctx,
      rootSessionId: "session-1",
      runtime: installedRuntime,
    });
    ctx.set(ChannelInstrumentationKey, {
      channelType: "schedule",
      kind: "schedule",
      metadata: { audience: "private" },
    });
    const second = ensureSessionInstrumentationPlan({
      agentName: "test-agent",
      ctx,
      rootSessionId: "session-1",
      runtime: installedRuntime,
    });

    expect(second).toBe(first);
    expect(tracePolicy).toHaveBeenCalledTimes(1);
    expect(parseSessionInstrumentationPlan(second)).toMatchObject({
      audience: "public",
      channelKind: "channel:web",
      channelType: "web",
    });
  });
});
