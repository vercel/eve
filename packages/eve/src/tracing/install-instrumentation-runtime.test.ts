import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AgentSessionIdKey, ChannelInstrumentationKey, SessionIdKey } from "#context/keys.js";
import { turnIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { otelIntegration, collectOtelPipeline } from "#tracing/otel-declaration.js";
import { publishTerminalSessionInstrumentation } from "#execution/terminal-session-instrumentation.js";

const { forceFlush, internalTerminalState, prepareSessionTrace, prepareTurnTrace, shutdown } =
  vi.hoisted(() => ({
    forceFlush: vi.fn(async () => undefined),
    internalTerminalState: vi.fn(),
    prepareSessionTrace: vi.fn(async () => ({
      isRemote: false,
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    })),
    prepareTurnTrace: vi.fn(async () => ({
      isRemote: false,
      spanId: "3".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    })),
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
    prepareSessionTrace,
    prepareTurnTrace,
    runInContext: (_operation: unknown, execute: () => PromiseLike<unknown>) => execute(),
  }),
}));

const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

describe("installInstrumentationRuntime", () => {
  beforeEach(() => {
    forceFlush.mockClear();
    internalTerminalState.mockClear();
    prepareSessionTrace.mockClear();
    prepareTurnTrace.mockClear();
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

    await contextStorage.run(new ContextContainer(), async () => {
      await runtime.hooks.publish({
        idempotencyKey,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
      await runtime.hooks.publish({
        idempotencyKey,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.completed",
      });
    });

    expect(internalTerminalState).toHaveBeenCalledExactlyOnceWith("framework");
    expect(authoredTerminalState).toHaveBeenCalledExactlyOnceWith("authored");
  });

  it("releases an Agent Run only when its root Workflow session ends", async () => {
    const releaseSession = vi.fn(async () => true);
    const processor = {
      forceFlush: vi.fn(async () => undefined),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      releaseSession,
      shutdown: vi.fn(async () => undefined),
    };
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration({ spanProcessors: [processor] })]),
      frameworkVersion: "test",
      providers: [],
      serviceName: "weather",
    });

    await runtime.hooks.publish({
      agentSessionId: "agent-session-1",
      idempotencyKey: "session:child-1",
      isRootSession: false,
      sessionId: "child-1",
      type: "session.completed",
    });
    await publishTerminalSessionInstrumentation({
      serializedContext: {
        [AgentSessionIdKey.name]: "agent-session-1",
        [SessionIdKey.name]: "root-1",
      },
      type: "session.completed",
    });

    expect(releaseSession).toHaveBeenCalledExactlyOnceWith("agent-session-1");
  });

  it("applies audience content policy to terminal failures", async () => {
    const terminalError = vi.fn();
    installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration()]),
      frameworkVersion: "test",
      providers: [
        {
          capture: "content",
          events: { "session.failed": (event) => terminalError(event.error) },
          name: "content-provider",
        },
      ],
      serviceName: "weather",
    });

    await publishTerminalSessionInstrumentation({
      error: new Error("private failure"),
      serializedContext: {
        [AgentSessionIdKey.name]: "agent-session-1",
        [ChannelInstrumentationKey.name]: {
          kind: "http",
          metadata: { audience: "private" },
        },
        [SessionIdKey.name]: "root-1",
      },
      type: "session.failed",
    });

    expect(terminalError).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
