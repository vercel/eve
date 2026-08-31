import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { turnIdempotencyKey } from "#instrumentation/lifecycle.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { otelIntegration, collectOtelPipeline } from "#tracing/otel-declaration.js";

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
      instrumentationProviders: true,
      providers: [{ flush: providerFlush, name: "test", shutdown: providerShutdown }],
      serviceName: "weather",
    });

    await runtime.forceFlush();
    await runtime.shutdown();
    await runtime.shutdown();

    expect(forceFlush).toHaveBeenCalledOnce();
    expect(providerFlush).toHaveBeenCalledOnce();
    expect(runtime.instrumentationProviders).toBe(true);
    expect(runtime.otelSettings).toEqual({
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
    const hooks = runtime.hooks.forTrace!({ agentName: "weather", audience: "unknown" });

    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        idempotencyKey,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
      await hooks.publish({
        idempotencyKey,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.completed",
      });
    });

    expect(internalTerminalState).toHaveBeenCalledExactlyOnceWith("framework");
    expect(authoredTerminalState).toHaveBeenCalledExactlyOnceWith("authored");
  });
});
