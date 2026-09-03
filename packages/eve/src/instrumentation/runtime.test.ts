import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  OtelTraceEnabledKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import { setChannelContext } from "#execution/channel-context.js";
import type { InstrumentationHooks } from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  bindSessionInstrumentation,
  initializeSessionInstrumentation,
  registerInstrumentationRuntime,
  type ExecutionInstrumentation,
  type InstrumentationRuntime,
  type InstrumentationStepScope,
} from "#instrumentation/runtime.js";
import { allocateChildSessionTraceSeed } from "#tracing/agent-child-trace-seed.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import { readForwardedAudienceBaggage, writeForwardedAudienceBaggage } from "#protocol/baggage.js";

const boundSession = {
  agentName: "test-agent",
  rootSessionId: "session-1",
  sessionId: "session-1",
};

function createRuntime(
  hooks: InstrumentationHooks,
  tracePolicy?: TraceCapturePolicy,
): InstrumentationRuntime {
  return {
    forceFlush: async () => undefined,
    hooks,
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

function createContext(audience: "private" | "public" | "unknown" = "public"): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ChannelInstrumentationKey, {
    kind: "channel:test",
    metadata: { audience },
  });
  return ctx;
}

async function readTelemetry(instrumentation: ExecutionInstrumentation | undefined) {
  return instrumentation?.prepareExecution().runStep(
    {
      environment: "test",
      eveVersion: "0.0.0",
      hasInput: false,
      session: { sessionId: "session-1" },
    },
    async (scope) => scope.telemetry(),
  );
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
});

function initializeRemoteSession(
  tracePolicy: TraceCapturePolicy,
  input: {
    readonly ceiling?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
    readonly liveAudience?: "private" | "public" | "unknown";
    readonly originAudience?: "private" | "public" | "unknown";
  } = {},
): ContextContainer {
  const originAudience = input.originAudience ?? "public";
  const ctx = createContext(input.liveAudience ?? originAudience);
  registerInstrumentationRuntime({
    ...createRuntime({ capturesContent: true, publish: vi.fn() }, tracePolicy),
    idGenerator: new AgentSpanIdGenerator(),
    prepareSessionTrace: vi.fn().mockResolvedValue(undefined),
  });
  initializeSessionInstrumentation({
    agentName: "remote-agent",
    ctx,
    parentTraceContext: {
      forwardedTracePolicy: {
        ceiling: input.ceiling ?? { recordInputs: true, recordOutputs: true },
        originAudience,
      },
      spanId: "c".repeat(16),
      traceFlags: 1,
      traceId: "d".repeat(32),
    },
  });
  return ctx;
}

describe("initializeSessionInstrumentation", () => {
  it("applies the receiver trace policy to a forwarded public audience", () => {
    const ctx = initializeRemoteSession(() => ({
      emit: true,
      recordInputs: false,
      recordOutputs: true,
    }));

    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
    expect(ctx.get(ParentTraceContextKey)).toMatchObject({
      decision: { action: "record", recordInputs: false, recordOutputs: true },
      traceFlags: 1,
    });
  });

  it("retains full capture for a sampled public remote trace", async () => {
    const ctx = initializeRemoteSession(() => true);

    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
    expect(ctx.get(ParentTraceContextKey)).toMatchObject({
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      traceFlags: 1,
    });
    expect(ctx.get(ParentTraceContextKey)).toMatchObject({ traceFlags: 1 });
    expect(ctx.get(ParentTraceContextKey)?.forwardedTracePolicy).toEqual({
      ceiling: { recordInputs: true, recordOutputs: true },
      originAudience: "public",
    });
    expect(
      await readTelemetry(
        bindSessionInstrumentation({
          agentName: "remote-agent",
          ctx,
          rootSessionId: "session-1",
          sessionId: "session-1",
        }),
      ),
    ).toMatchObject({ recordInputs: true, recordOutputs: true });
  });

  it.each([
    ["unknown", true],
    ["private", false],
  ] as const)(
    "applies the live %s delivery audience independently from a public origin",
    async (deliveryAudience, recordsContent) => {
      const ctx = initializeRemoteSession(() => true);
      ctx.set(ChannelInstrumentationKey, {
        kind: "channel:test",
        metadata: { audience: deliveryAudience },
      });

      expect(
        await readTelemetry(
          bindSessionInstrumentation({
            agentName: "remote-agent",
            ctx,
            rootSessionId: "session-1",
            sessionId: "session-1",
          }),
        ),
      ).toMatchObject({
        recordInputs: recordsContent,
        recordOutputs: recordsContent,
      });
    },
  );

  it("does not let a forwarded policy override a receiver drop decision", () => {
    const ctx = initializeRemoteSession(() => false);

    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
    expect(ctx.get(ParentTraceContextKey)).toMatchObject({
      decision: { action: "drop" },
      traceFlags: 0,
    });
  });

  it("keeps a remote child seed separate from its parent link context", () => {
    const ctx = createContext("public");
    registerInstrumentationRuntime({
      ...createRuntime({ capturesContent: true, publish: vi.fn() }, () => false),
      idGenerator: new AgentSpanIdGenerator(),
      prepareSessionTrace: vi.fn().mockResolvedValue(undefined),
    });
    const parentTraceContext = {
      forwardedTracePolicy: {
        ceiling: { recordInputs: true, recordOutputs: true },
        originAudience: "public" as const,
      },
      isRemote: true,
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    initializeSessionInstrumentation({
      agentName: "remote-agent",
      ctx,
      parentTraceContext,
      traceSeed: {
        spanId: "4".repeat(16),
        traceFlags: 1,
        traceId: "3".repeat(32),
      },
    });

    expect(ctx.get(SessionTraceSeedKey)).toMatchObject({
      decision: { action: "drop" },
      spanId: "4".repeat(16),
      traceFlags: 0,
      traceId: "3".repeat(32),
    });
    expect(ctx.get(ParentTraceContextKey)).toMatchObject({
      decision: { action: "drop" },
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    });
  });

  it("allows private content only within both hop ceilings", async () => {
    const ctx = initializeRemoteSession(
      () => ({ emit: true, recordInputs: true, recordOutputs: true }),
      {
        ceiling: { recordInputs: true, recordOutputs: false },
        liveAudience: "unknown",
        originAudience: "private",
      },
    );

    expect(ctx.get(ParentTraceContextKey)?.decision).toEqual({
      action: "record",
      recordInputs: true,
      recordOutputs: false,
    });
    await expect(
      readTelemetry(
        bindSessionInstrumentation({
          agentName: "remote-agent",
          ctx,
          rootSessionId: "session-1",
          sessionId: "session-1",
        }),
      ),
    ).resolves.toMatchObject({ recordInputs: true, recordOutputs: false });
  });

  it("redacts runtime-context model input when the forwarded ceiling denies inputs", async () => {
    const ctx = createContext("public");
    const runtime = createRuntime({ capturesContent: true, publish: vi.fn() }, () => ({
      emit: true,
      recordInputs: true,
      recordOutputs: true,
    }));
    runtime.stepStartedRuntimeContextResolver = (event) => ({
      runtimeContext: { messageCount: event.modelInput.messages.length },
    });
    registerInstrumentationRuntime({
      ...runtime,
      idGenerator: new AgentSpanIdGenerator(),
      prepareSessionTrace: vi.fn().mockResolvedValue(undefined),
    });
    initializeSessionInstrumentation({
      agentName: "remote-agent",
      ctx,
      parentTraceContext: {
        forwardedTracePolicy: {
          ceiling: { recordInputs: false, recordOutputs: true },
          originAudience: "public",
        },
        spanId: "c".repeat(16),
        traceFlags: 1,
        traceId: "d".repeat(32),
      },
    });

    const messageCount = await bindSessionInstrumentation({
      agentName: "remote-agent",
      ctx,
      rootSessionId: "session-1",
      sessionId: "session-1",
    })
      ?.prepareExecution()
      .runStep(
        {
          environment: "test",
          eveVersion: "0.0.0",
          hasInput: true,
          session: { sessionId: "session-1" },
        },
        async (scope) =>
          scope.resolveRuntimeContext({
            eveVersion: "0.0.0",
            emissionState: { sessionStarted: true, sequence: 0, stepIndex: 0, turnId: "turn-1" },
            environment: "test",
            modelInput: {
              instructions: "private",
              messages: [{ content: "secret", role: "user" }],
            },
            session: { sessionId: "session-1" } as never,
          })?.["messageCount"],
      );

    expect(messageCount).toBe(0);
  });

  it("narrows monotonically across a three-hop chain", () => {
    const receiverPolicies = [
      { emit: true, recordInputs: true, recordOutputs: true },
      { emit: true, recordInputs: false, recordOutputs: true },
      { emit: true, recordInputs: true, recordOutputs: false },
    ] as const;
    let ceiling = { recordInputs: true, recordOutputs: true };

    for (const receiverPolicy of receiverPolicies) {
      const previous = ceiling;
      const ctx = initializeRemoteSession(() => receiverPolicy, {
        ceiling: previous,
        originAudience: "private",
      });
      const decision = ctx.get(ParentTraceContextKey)?.decision;
      expect(decision?.action).toBe("record");
      if (decision?.action !== "record") throw new Error("Expected a record decision");
      ceiling = {
        recordInputs: decision.recordInputs,
        recordOutputs: decision.recordOutputs,
      };
      expect(Number(ceiling.recordInputs)).toBeLessThanOrEqual(Number(previous.recordInputs));
      expect(Number(ceiling.recordOutputs)).toBeLessThanOrEqual(Number(previous.recordOutputs));
      const relayed = readForwardedAudienceBaggage(
        writeForwardedAudienceBaggage(undefined, {
          ceiling,
          originAudience: "private",
        }) ?? null,
      );
      expect(relayed).toEqual({ ceiling, originAudience: "private" });
      if (typeof relayed !== "object") throw new Error("Expected a relayed trace assertion");
      ceiling = relayed.ceiling;
    }

    expect(ceiling).toEqual({ recordInputs: false, recordOutputs: false });
  });

  it("preserves sampled flags for a non-forwarded parent decision", () => {
    const ctx = createContext("public");
    ctx.set(ParentTraceContextKey, {
      decision: { action: "drop" },
      spanId: "c".repeat(16),
      traceFlags: 1,
      traceId: "d".repeat(32),
    });
    registerInstrumentationRuntime({
      ...createRuntime({ capturesContent: true, publish: vi.fn() }, () => false),
      idGenerator: new AgentSpanIdGenerator(),
      prepareSessionTrace: vi.fn().mockResolvedValue(undefined),
    });
    initializeSessionInstrumentation({
      agentName: "local-subagent",
      ctx,
      parentTraceContext: ctx.get(ParentTraceContextKey),
    });

    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
    expect(ctx.get(ParentTraceContextKey)).toMatchObject({ traceFlags: 1 });
  });
});

describe("bindInstrumentationRuntime", () => {
  it("returns no worker controls when no runtime is loaded", () => {
    expect(
      bindInstrumentationRuntime(undefined, new ContextContainer(), boundSession),
    ).toBeUndefined();
  });

  it("reads the channel audience when the step runs", async () => {
    const ctx = createContext("public");
    const instrumentation = bindInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }),
      ctx,
      boundSession,
    );

    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "private" },
    });

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
    });
  });

  it("binds provider hooks to the step-entry agent and channel", async () => {
    const boundHooks: InstrumentationHooks = { capturesContent: false, publish: vi.fn() };
    const forTrace = vi.fn(() => boundHooks);
    const ctx = createContext("private");
    ctx.set(ChannelInstrumentationKey, {
      channelType: "slack",
      kind: "channel:test",
      metadata: { audience: "private" },
    });
    const instrumentation = bindInstrumentationRuntime(
      createRuntime({ capturesContent: false, forTrace, publish: vi.fn() }),
      ctx,
      { ...boundSession, agentName: "Weather Display Name" },
    );

    await readTelemetry(instrumentation);

    expect(forTrace).toHaveBeenCalledExactlyOnceWith({
      agentName: "Weather Display Name",
      audience: "private",
      channelType: "slack",
    });
  });

  it("keeps the step-entry audience for the rest of the step", async () => {
    const ctx = createContext("private");
    const instrumentation = bindInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }),
      ctx,
      boundSession,
    );

    const telemetry = await instrumentation?.prepareExecution().runStep(
      {
        environment: "test",
        eveVersion: "0.0.0",
        hasInput: false,
        session: { sessionId: "session-1" },
      },
      async (scope) => {
        ctx.set(ChannelInstrumentationKey, {
          kind: "channel:test",
          metadata: { audience: "public" },
        });
        expect(
          scope.prepareAttempt({
            attemptIndex: 0,
            stepIndex: 0,
            turnId: "turn-1",
          })?.scope.channelAudience,
        ).toBe("private");
        return scope.telemetry();
      },
    );

    expect(telemetry).toMatchObject({ recordInputs: false, recordOutputs: false });
  });

  it("uses one framework-owned span tree when the runtime owns agent spans", async () => {
    const originalIntegrations = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS;
    const authoredIntegration = { onStart: vi.fn() };
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [authoredIntegration];
    const runtime = {
      ...createRuntime({ capturesContent: true, publish: vi.fn() }),
      ownsAgentSpans: true,
    };
    const instrumentation = bindInstrumentationRuntime(runtime, createContext(), boundSession);

    try {
      const result = await instrumentation?.prepareExecution().runStep(
        {
          environment: "test",
          eveVersion: "0.0.0",
          hasInput: true,
          session: { sessionId: "session-1", state: {} as Record<string, unknown> },
        },
        async (scope) => ({
          integrations: scope.prepareAttempt({
            attemptIndex: 0,
            stepIndex: 0,
            turnId: "turn-1",
          }).telemetry?.integrations,
          session: scope.session,
        }),
      );

      expect(result?.session.state?.["eve.harness.turnTrace"]).toBeUndefined();
      expect(result?.integrations).toEqual([
        expect.objectContaining({ onStart: expect.any(Function) }),
        authoredIntegration,
      ]);
      expect(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS).toEqual([authoredIntegration]);
    } finally {
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = originalIntegrations;
    }
  });

  it("isolates concurrent step decisions and audiences", async () => {
    const ctx = createContext("private");
    const runtime = createRuntime({ capturesContent: true, publish: vi.fn() });
    runtime.stepStartedRuntimeContextResolver = (event) => ({
      runtimeContext: { messageCount: event.modelInput.messages.length },
    });
    const instrumentation = bindInstrumentationRuntime(
      runtime,
      ctx,
      boundSession,
    )?.prepareExecution();
    let releaseFirst!: () => void;
    const waitForSecond = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const stepInput = {
      environment: "test",
      eveVersion: "0.0.0",
      hasInput: false,
      session: { sessionId: "session-1" },
    };
    const readScopedState = (scope: InstrumentationStepScope<{ sessionId: string }>) => ({
      messageCount: scope.resolveRuntimeContext({
        eveVersion: "0.0.0",
        emissionState: { sessionStarted: true, sequence: 0, stepIndex: 0, turnId: "turn-1" },
        environment: "test",
        modelInput: { instructions: undefined, messages: [{ content: "secret", role: "user" }] },
        session: { sessionId: "session-1" } as never,
      })?.["messageCount"],
      telemetry: scope.telemetry(),
    });

    const first = instrumentation?.runStep(stepInput, async (scope) => {
      await waitForSecond;
      return readScopedState(scope);
    });
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "public" },
    });
    const second = instrumentation?.runStep(stepInput, async (scope) => readScopedState(scope));
    releaseFirst();

    await expect(first).resolves.toMatchObject({
      messageCount: 0,
      telemetry: { recordInputs: false, recordOutputs: false },
    });
    await expect(second).resolves.toMatchObject({
      messageCount: 1,
      telemetry: { recordInputs: true, recordOutputs: true },
    });
  });

  it("uses the directional decision from the existing trace seed", async () => {
    const ctx = createContext();
    ctx.set(SessionTraceSeedKey, {
      decision: { action: "record", recordInputs: true, recordOutputs: false },
      spanId: "1".repeat(16),
      traceFlags: 1,
      traceId: "2".repeat(32),
    });
    const instrumentation = bindInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }),
      ctx,
      boundSession,
    );

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: true,
      recordOutputs: false,
    });
  });

  it("fails a malformed durable trace decision closed", async () => {
    const ctx = createContext();
    ctx.set(SessionTraceSeedKey, {
      decision: {
        action: "record",
        recordInputs: "yes",
        recordOutputs: true,
      } as never,
      spanId: "1".repeat(16),
      traceFlags: 1,
      traceId: "2".repeat(32),
    });

    expect(
      await readTelemetry(
        bindInstrumentationRuntime(
          createRuntime({ capturesContent: true, publish: vi.fn() }),
          ctx,
          boundSession,
        ),
      ),
    ).toMatchObject({ recordInputs: false, recordOutputs: false });
  });

  it("fails a malformed durable forwarded assertion closed", async () => {
    const ctx = createContext();
    ctx.set(SessionTraceSeedKey, {
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      forwardedTracePolicy: { originAudience: "public" } as never,
      spanId: "1".repeat(16),
      traceFlags: 1,
      traceId: "2".repeat(32),
    });

    expect(
      await readTelemetry(
        bindInstrumentationRuntime(
          createRuntime({ capturesContent: true, publish: vi.fn() }),
          ctx,
          boundSession,
        ),
      ),
    ).toMatchObject({ recordInputs: false, recordOutputs: false });
  });

  it("applies the live audience ceiling to a seeded decision", async () => {
    const ctx = createContext("private");
    ctx.set(SessionTraceSeedKey, {
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      spanId: "1".repeat(16),
      traceFlags: 1,
      traceId: "2".repeat(32),
    });
    const instrumentation = bindInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }),
      ctx,
      boundSession,
    );

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
    });
  });

  it("retains content after a local subagent adapter refresh", async () => {
    const ctx = createContext("public");
    ctx.set(SessionTraceSeedKey, {
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      spanId: "1".repeat(16),
      traceFlags: 1,
      traceId: "2".repeat(32),
    });

    setChannelContext(ctx, { kind: "subagent", state: { persisted: true } });

    expect(ctx.get(ChannelInstrumentationKey)?.metadata.audience).toBe("public");
    expect(
      await readTelemetry(
        bindInstrumentationRuntime(
          createRuntime({ capturesContent: true, publish: vi.fn() }),
          ctx,
          boundSession,
        ),
      ),
    ).toMatchObject({ recordInputs: true, recordOutputs: true });
  });

  it("derives a legacy seed decision from trace flags", async () => {
    const policy = vi.fn(() => true);
    const ctx = createContext();
    ctx.set(SessionTraceSeedKey, {
      spanId: "1".repeat(16),
      traceFlags: 0,
      traceId: "2".repeat(32),
    });
    const instrumentation = bindInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }, policy),
      ctx,
      boundSession,
    );

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
    });
    expect(policy).not.toHaveBeenCalled();
  });
});

describe("bindSessionInstrumentation", () => {
  it("uses a persisted decision without migrating the durable context", async () => {
    const policy = vi.fn(() => true);
    registerInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }, policy),
    );
    const ctx = createContext();
    contextStorage.run(ctx, () => {
      new ContextAgentTraceStateStore().setSession("session-1", {
        context: { spanId: "1".repeat(16), traceFlags: 1, traceId: "2".repeat(32) },
        decision: { action: "record", recordInputs: false, recordOutputs: true },
        rootSessionId: "session-1",
      });
    });

    const instrumentation = bindSessionInstrumentation({
      agentName: "test-agent",
      ctx,
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: false,
      recordOutputs: true,
    });
    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
    expect(policy).not.toHaveBeenCalled();
  });

  it("reevaluates policy for seedless steps", async () => {
    const policy = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    registerInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }, policy),
    );
    const ctx = createContext();
    const instrumentation = bindSessionInstrumentation({
      agentName: "test-agent",
      ctx,
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
    });
    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: true,
      recordOutputs: true,
    });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
  });

  it("does not treat the legacy OTel marker as an admission decision", async () => {
    const policy = vi.fn(() => true);
    registerInstrumentationRuntime(
      createRuntime({ capturesContent: true, publish: vi.fn() }, policy),
    );
    const ctx = createContext();
    ctx.set(OtelTraceEnabledKey, false);
    const instrumentation = bindSessionInstrumentation({
      agentName: "test-agent",
      ctx,
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(await readTelemetry(instrumentation)).toMatchObject({
      recordInputs: true,
      recordOutputs: true,
    });
    expect(policy).toHaveBeenCalledOnce();
    expect(ctx.get(SessionTraceSeedKey)).toBeUndefined();
  });
});

describe("initializeSessionInstrumentation", () => {
  function registerSeedRuntime(input: {
    readonly samplesTrace?: (traceId: string) => boolean;
    readonly tracePolicy?: TraceCapturePolicy;
  }): void {
    registerInstrumentationRuntime({
      ...createRuntime({ capturesContent: true, publish: vi.fn() }, input.tracePolicy),
      idGenerator: new AgentSpanIdGenerator(),
      prepareSessionTrace: async () => ({ spanId: "", traceFlags: 0, traceId: "" }),
      samplesTrace: input.samplesTrace,
    });
  }

  it("marks the seed unsampled when the installed sampler drops the trace", () => {
    const samplesTrace = vi.fn(() => false);
    registerSeedRuntime({ samplesTrace });
    const ctx = createContext();

    initializeSessionInstrumentation({ agentName: "test-agent", ctx });

    const seed = ctx.get(SessionTraceSeedKey);
    expect(seed?.traceFlags).toBe(0);
    expect(seed?.decision).toMatchObject({ action: "record" });
    expect(samplesTrace).toHaveBeenCalledExactlyOnceWith(seed?.traceId);
  });

  it("keeps the seed sampled when the sampler admits the trace", () => {
    registerSeedRuntime({ samplesTrace: () => true });
    const ctx = createContext();

    initializeSessionInstrumentation({ agentName: "test-agent", ctx });

    expect(ctx.get(SessionTraceSeedKey)?.traceFlags).toBe(1);
  });

  it("stays sampled when no sampler capability is installed", () => {
    registerSeedRuntime({});
    const ctx = createContext();

    initializeSessionInstrumentation({ agentName: "test-agent", ctx });

    expect(ctx.get(SessionTraceSeedKey)?.traceFlags).toBe(1);
  });

  it("skips the sampler when policy already drops the trace", () => {
    const samplesTrace = vi.fn(() => true);
    registerSeedRuntime({ samplesTrace, tracePolicy: () => false });
    const ctx = createContext();

    initializeSessionInstrumentation({ agentName: "test-agent", ctx });

    expect(ctx.get(SessionTraceSeedKey)?.traceFlags).toBe(0);
    expect(samplesTrace).not.toHaveBeenCalled();
  });

  it("preallocates only distinct replay-stable coordinates for each child dispatch", () => {
    registerSeedRuntime({});
    const parentTraceContext = {
      decision: { action: "record", recordInputs: true, recordOutputs: false } as const,
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    const input = {
      callId: "call-1",
      parentTraceContext,
      sessionId: "parent-session",
      turnId: "turn-1",
    };

    const first = allocateChildSessionTraceSeed(input);
    const replay = allocateChildSessionTraceSeed(input);
    const sibling = allocateChildSessionTraceSeed({ ...input, callId: "call-2" });

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ traceFlags: 0 });
    expect(first).not.toHaveProperty("decision");
    expect(first?.traceId).not.toBe(parentTraceContext.traceId);
    expect(sibling?.traceId).not.toBe(first?.traceId);
  });

  it("preallocates a child trace even when the parent action was not sampled", () => {
    registerSeedRuntime({});

    const seed = allocateChildSessionTraceSeed({
      callId: "call-1",
      sessionId: "parent-session",
      turnId: "turn-1",
    });

    expect(seed).toMatchObject({
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/u),
      traceFlags: 0,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
  });

  it("evaluates a preallocated child with its own policy and sampler exactly once", async () => {
    const tracePolicy = vi.fn(() => ({ emit: true, recordInputs: false, recordOutputs: true }));
    const samplesTrace = vi.fn(() => true);
    registerSeedRuntime({ samplesTrace, tracePolicy });
    const ctx = createContext();
    const parentTraceContext = {
      decision: { action: "drop" } as const,
      spanId: "2".repeat(16),
      traceFlags: 0,
      traceId: "1".repeat(32),
    };
    const allocated = allocateChildSessionTraceSeed({
      callId: "call-child",
      parentTraceContext,
      sessionId: "parent-session",
      turnId: "parent-turn",
    });
    if (allocated === undefined) throw new Error("expected child trace allocation");

    initializeSessionInstrumentation({
      agentName: "child-agent",
      ctx,
      parentTraceContext,
      traceSeed: allocated,
    });
    const instrumentation = bindSessionInstrumentation({
      agentName: "child-agent",
      ctx,
      rootSessionId: "child-session",
      sessionId: "child-session",
    });

    expect(ctx.get(SessionTraceSeedKey)).toEqual({
      ...allocated,
      decision: { action: "record", recordInputs: false, recordOutputs: true },
      forwardedTracePolicy: undefined,
      traceFlags: 1,
    });
    await readTelemetry(instrumentation);
    await readTelemetry(instrumentation);
    expect(tracePolicy).toHaveBeenCalledOnce();
    expect(samplesTrace).toHaveBeenCalledExactlyOnceWith(allocated.traceId);
  });

  it("intersects an unsampled parent's forwarded ceiling with the child policy", () => {
    registerSeedRuntime({
      samplesTrace: () => true,
      tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
    });
    const ctx = createContext();
    const traceSeed = {
      forwardedTracePolicy: {
        ceiling: { recordInputs: false, recordOutputs: true },
        originAudience: "private" as const,
      },
      spanId: "4".repeat(16),
      traceFlags: 0,
      traceId: "3".repeat(32),
    };

    initializeSessionInstrumentation({ agentName: "child-agent", ctx, traceSeed });

    expect(ctx.get(SessionTraceSeedKey)).toMatchObject({
      decision: { action: "record", recordInputs: false, recordOutputs: true },
      forwardedTracePolicy: traceSeed.forwardedTracePolicy,
      traceFlags: 1,
    });
  });
});
