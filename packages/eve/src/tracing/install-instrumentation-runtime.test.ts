import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { turnIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import { constructInstrumentation } from "#harness/instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { otel, otelIntegration, collectOtelPipeline } from "#tracing/otel-declaration.js";

const { forceFlush, internalTerminalState, shutdown } = vi.hoisted(() => ({
  forceFlush: vi.fn(async () => undefined),
  internalTerminalState: vi.fn(),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock("#tracing/otel-registration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#tracing/otel-registration.js")>();
  return {
    ...actual,
    registerOtelPipeline: () => ({
      forceFlush,
      idGenerator: {
        allocateSpanId: () => "1".repeat(16),
        withSpanId: (_spanId: string, run: () => unknown) => run(),
      },
      shutdown,
    }),
  };
});

vi.mock("#tracing/agent-otel-provider.js", () => ({
  createAgentOtelInstrumentation: () => ({
    hook: {
      events: {
        "turn.completed": (_event: unknown, ctx: { state: { get(): unknown } }) => {
          internalTerminalState(ctx.state.get());
        },
        "turn.started": (_event: unknown, ctx: { state: { set(value: string): void } }) => {
          ctx.state.set("framework");
        },
      },
      name: "eve.otel",
    },
    runInContext: (_operation: unknown, execute: () => PromiseLike<unknown>) => execute(),
  }),
}));

const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

describe("installInstrumentationRuntime", () => {
  beforeEach(() => {
    forceFlush.mockClear();
    internalTerminalState.mockClear();
    shutdown.mockClear();
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it("flushes and shuts down the registered tracer provider", async () => {
    const providerFlush = vi.fn();
    const providerShutdown = vi.fn();
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration()]),
      frameworkVersion: "test",
      providers: [{ flush: providerFlush, name: "test", shutdown: providerShutdown }],
      serviceName: "weather",
    });

    await runtime.forceFlush();
    await runtime.shutdown();
    await runtime.shutdown();

    expect(forceFlush).toHaveBeenCalledOnce();
    expect(providerFlush).toHaveBeenCalledOnce();
    expect(runtime.traceChannelRequests).toBe(false);
    expect(
      constructInstrumentation(runtime, {
        action: "record",
        recordInputs: true,
        recordOutputs: true,
      }).harness?.otelSettings,
    ).toMatchObject({
      functionId: undefined,
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(providerShutdown).toHaveBeenCalledOnce();
  });

  it("isolates authored state from an internal provider with the same name", async () => {
    const authoredTerminalState = vi.fn();
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration()]),
      frameworkVersion: "test",
      providers: [
        {
          events: {
            "turn.completed": (_event, ctx) => authoredTerminalState(ctx.state.get()),
            "turn.started": (_event, ctx) => ctx.state.set("authored"),
          },
          name: "eve.otel",
          stateNamespace: "authored:eve.otel",
        },
      ],
      serviceName: "weather",
    });
    const idempotencyKey = turnIdempotencyKey("session-1", "turn-1");
    const instrumentation = constructInstrumentation(runtime, {
      action: "record",
      recordInputs: true,
      recordOutputs: true,
    }).harness!;

    await contextStorage.run(new ContextContainer(), async () => {
      await instrumentation.hooks.publish({
        idempotencyKey,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
      await instrumentation.hooks.publish({
        idempotencyKey,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.completed",
      });
    });

    expect(internalTerminalState).toHaveBeenCalledExactlyOnceWith("framework");
    expect(authoredTerminalState).toHaveBeenCalledExactlyOnceWith("authored");
  });

  it("maps audience to controls before the harness", () => {
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration()]),
      frameworkVersion: "test",
      providers: [],
      serviceName: "weather",
    });
    const context = { rootSessionId: "session-1", sessionId: "session-1" };

    expect(runtime.resolveDecision({ ...context, audience: "public" })).toEqual({
      action: "record",
      recordInputs: true,
      recordOutputs: true,
    });
    expect(runtime.resolveDecision({ ...context, audience: "private" })).toEqual({
      action: "drop",
      recordInputs: false,
      recordOutputs: false,
    });
  });

  it("uses the controls returned by a custom trace policy", () => {
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([
        otel({
          tracePolicy: () => ({
            action: "record",
            recordInputs: false,
            recordOutputs: true,
          }),
        }),
        otelIntegration(),
      ]),
      frameworkVersion: "test",
      providers: [],
      serviceName: "weather",
    });

    expect(
      runtime.resolveDecision({
        audience: "private",
        rootSessionId: "session-1",
        sessionId: "session-1",
      }),
    ).toEqual({ action: "record", recordInputs: false, recordOutputs: true });
  });

  it("fails closed when a trace policy throws", () => {
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([
        otel({
          tracePolicy: () => {
            throw new Error("policy failed");
          },
        }),
        otelIntegration(),
      ]),
      frameworkVersion: "test",
      providers: [],
      serviceName: "weather",
    });

    expect(
      runtime.resolveDecision({
        audience: "public",
        rootSessionId: "session-1",
        sessionId: "session-1",
      }),
    ).toEqual({ action: "drop", recordInputs: false, recordOutputs: false });
  });

  it("suppresses only the internal OTel provider for dropped deliveries", async () => {
    const authoredTurnStarted = vi.fn();
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration()]),
      frameworkVersion: "test",
      providers: [
        {
          events: { "turn.started": authoredTurnStarted },
          name: "authored",
        },
      ],
      serviceName: "weather",
    });
    const instrumentation = constructInstrumentation(runtime, {
      action: "drop",
      recordInputs: false,
      recordOutputs: false,
    }).harness!;

    await contextStorage.run(new ContextContainer(), async () => {
      await instrumentation.hooks.publish({
        idempotencyKey: "turn-1",
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
      await instrumentation.hooks.publish({
        idempotencyKey: "turn-1",
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.completed",
      });
    });

    expect(authoredTurnStarted).toHaveBeenCalledOnce();
    expect(internalTerminalState).not.toHaveBeenCalled();
  });
});
