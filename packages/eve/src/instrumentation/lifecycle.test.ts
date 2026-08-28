import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  createInstrumentationHooks,
  inputIdempotencyKey,
  modelCallIdempotencyKey,
  sessionIdempotencyKey,
  toolCallIdempotencyKey,
  turnIdempotencyKey,
  type InstrumentationAttemptScope,
  type InstrumentationModelCallStartedEvent,
  type InstrumentationProviderDefinition,
  type InstrumentationToolCallCompletedEvent,
} from "#instrumentation/lifecycle.js";
import {
  findInstrumentationActionScopeForCall,
  instrumentationStateSlot,
  rememberInstrumentationActionScope,
} from "#instrumentation/state.js";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("#internal/logging.js", () => ({
  createLogger: () => ({ warn: logWarn }),
  formatError: (error: unknown) => error,
}));

const scope: InstrumentationAttemptScope = {
  attemptId: "session-1:turn-1:0:0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("instrumentation idempotency keys", () => {
  it("separates classes that share an identifier", () => {
    expect(sessionIdempotencyKey("shared")).not.toBe(turnIdempotencyKey("shared", "shared"));
  });

  it("separates identical turn IDs in different sessions", () => {
    expect(turnIdempotencyKey("session-1", "turn_0")).not.toBe(
      turnIdempotencyKey("session-2", "turn_0"),
    );
  });

  it("scopes input requests to their originating turn", () => {
    expect(inputIdempotencyKey("session-1", "turn-1", "request-1")).toBe(
      "input:session-1:turn-1:request-1",
    );
    expect(inputIdempotencyKey("session-1", "turn-1", "request-1")).not.toBe(
      inputIdempotencyKey("session-1", "turn-2", "request-1"),
    );
  });

  it("derives model identity without an AI SDK call ID", () => {
    expect(modelCallIdempotencyKey(scope, 2)).toBe("model:session-1:turn-1:0:0:2");
  });

  it("separates model attempts and SDK tool calls", () => {
    const retry = { ...scope, attemptId: "session-1:turn-1:0:1", attemptIndex: 1 };
    expect(attemptIdempotencyKey(scope)).not.toBe(attemptIdempotencyKey(retry));
    expect(modelCallIdempotencyKey(scope, 0)).not.toBe(toolCallIdempotencyKey(scope, "call-1", 0));
  });
});

describe("provider state lifecycle", () => {
  const started = {
    idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
    rootSessionId: "session-1",
    sequence: 0,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started" as const,
  };
  const completed = {
    idempotencyKey: started.idempotencyKey,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed" as const,
  };

  it("carries a value from a start to its terminal and releases it", async () => {
    let observed: unknown;
    const hooks = createInstrumentationHooks([
      {
        events: {
          "turn.completed": (_event, ctx) => {
            observed = ctx.state.get();
          },
          "turn.started": (_event, ctx) => ctx.state.set({ rowId: "row-1" }),
        },
        name: "sink",
      },
    ]);

    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
      expect(instrumentationStateSlot("sink", started.idempotencyKey).get()).toBeUndefined();
    });
    expect(observed).toEqual({ rowId: "row-1" });
  });

  it("releases state when no terminal handler exists", async () => {
    const hooks = createInstrumentationHooks([
      { events: { "turn.started": (_event, ctx) => ctx.state.set("open") }, name: "sink" },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
      expect(instrumentationStateSlot("sink", started.idempotencyKey).get()).toBeUndefined();
    });
  });

  it("releases terminal state after its provider is removed", async () => {
    const starts = createInstrumentationHooks([
      { events: { "turn.started": (_event, ctx) => ctx.state.set("open") }, name: "removed" },
    ]);
    const terminals = createInstrumentationHooks([]);
    await contextStorage.run(new ContextContainer(), async () => {
      await starts.publish(started);
      await terminals.publish(completed);
      expect(instrumentationStateSlot("removed", started.idempotencyKey).get()).toBeUndefined();
    });
  });

  it("keeps input state past its attempt and restores it for resolution", async () => {
    const key = inputIdempotencyKey(scope.sessionId, scope.turnId, "request-1");
    const context = new ContextContainer();
    const starts = createInstrumentationHooks([
      {
        events: { "input.requested": (_event, ctx) => ctx.state.set({ rowId: "input-1" }) },
        name: "sink",
      },
    ]);
    await contextStorage.run(context, async () => {
      await starts.publish({
        action: { callId: "call-1", name: "weather" },
        idempotencyKey: key,
        kind: "tool-approval",
        request: { prompt: "Approve weather?" },
        requestId: "request-1",
        scope,
        type: "input.requested",
      });
      await starts.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
    });

    const observed: unknown[] = [];
    const restored = await deserializeContext(await serializeContext(context));
    const terminals = createInstrumentationHooks([
      {
        events: { "input.resolved": (_event, ctx) => void observed.push(ctx.state.get()) },
        name: "sink",
      },
    ]);
    await contextStorage.run(restored, async () => {
      await terminals.publish({
        idempotencyKey: key,
        kind: "tool-approval",
        outcome: "approved",
        requestId: "request-1",
        response: { optionId: "approve" },
        scope,
        type: "input.resolved",
      });
      expect(instrumentationStateSlot("sink", key).get()).toBeUndefined();
    });
    expect(observed).toEqual([{ rowId: "input-1" }]);
  });

  it("releases unterminated model state when its attempt ends", async () => {
    const modelKey = modelCallIdempotencyKey(scope, 0);
    const hooks = createInstrumentationHooks([
      {
        events: { "model.call.started": (_event, ctx) => ctx.state.set("open") },
        name: "sink",
      },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        idempotencyKey: modelKey,
        input: { messages: [] },
        model: { modelId: "model", provider: "test" },
        scope,
        type: "model.call.started",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
      expect(instrumentationStateSlot("sink", modelKey).get()).toBeUndefined();
    });
  });

  it("releases attempt-owned state after its provider is removed", async () => {
    const modelKey = modelCallIdempotencyKey(scope, 0);
    const starts = createInstrumentationHooks([
      {
        events: { "model.call.started": (_event, ctx) => ctx.state.set("open") },
        name: "removed",
      },
    ]);
    const terminals = createInstrumentationHooks([]);
    await contextStorage.run(new ContextContainer(), async () => {
      await starts.publish({
        idempotencyKey: modelKey,
        input: { messages: [] },
        model: { modelId: "model", provider: "test" },
        scope,
        type: "model.call.started",
      });
      await terminals.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
      expect(instrumentationStateSlot("removed", modelKey).get()).toBeUndefined();
    });
  });

  it("keeps action state past the originating attempt", async () => {
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1");
    const hooks = createInstrumentationHooks([
      {
        events: { "action.started": (_event, ctx) => ctx.state.set("open") },
        name: "sink",
      },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        callId: "call-1",
        idempotencyKey: actionKey,
        input: {},
        kind: "tool-call",
        name: "tool",
        scope,
        type: "action.started",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
      expect(instrumentationStateSlot("sink", actionKey).get()).toBe("open");
    });
  });

  it("terminalizes and releases pending actions when a turn is cancelled", async () => {
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1");
    const failed = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "action.failed": failed,
          "action.started": (_event, ctx) => ctx.state.set("open"),
        },
        name: "sink",
      },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      rememberInstrumentationActionScope(actionKey, scope);
      await hooks.publish({
        callId: "call-1",
        idempotencyKey: actionKey,
        input: {},
        kind: "tool-call",
        name: "tool",
        scope,
        type: "action.started",
      });
      await hooks.publish({
        idempotencyKey: turnIdempotencyKey(scope.sessionId, scope.turnId),
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        type: "turn.cancelled",
      });
      expect(instrumentationStateSlot("sink", actionKey).get()).toBeUndefined();
      expect(findInstrumentationActionScopeForCall(scope.sessionId, "call-1")).toBeUndefined();
    });
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({
      errorCode: "ACTION_CANCELLED",
      outcome: "cancelled",
      type: "action.failed",
    });
  });
});

describe("provider handler deadlines", () => {
  const key = turnIdempotencyKey("session-1", "turn-1");
  const started = {
    idempotencyKey: key,
    rootSessionId: "session-1",
    sequence: 0,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started" as const,
  };
  const completed = {
    idempotencyKey: key,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed" as const,
  };
  const hang = () => new Promise<void>(() => {});

  it("lets providers behind a hanging handler run", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks(
      [
        { events: { "turn.started": hang }, name: "hangs" },
        { events: { "turn.started": after }, name: "after" },
      ],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(new ContextContainer(), () => hooks.publish(started));
    expect(after).toHaveBeenCalledOnce();
  });

  it("persists abandonment across workers and skips the terminal", async () => {
    const terminal = vi.fn();
    const context = new ContextContainer();
    const starts = createInstrumentationHooks(
      [{ events: { "turn.started": hang }, name: "sink" }],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(context, () => starts.publish(started));

    const restored = await deserializeContext(await serializeContext(context));
    const terminals = createInstrumentationHooks(
      [{ events: { "turn.completed": terminal }, name: "sink" }],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(restored, () => terminals.publish(completed));
    expect(terminal).not.toHaveBeenCalled();
  });

  it("abandons a timed-out input request across workers", async () => {
    const key = inputIdempotencyKey(scope.sessionId, scope.turnId, "request-1");
    const context = new ContextContainer();
    const starts = createInstrumentationHooks(
      [{ events: { "input.requested": hang }, name: "sink" }],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(context, () =>
      starts.publish({
        action: { callId: "call-1", name: "weather" },
        idempotencyKey: key,
        kind: "tool-approval",
        request: { prompt: "Approve weather?" },
        requestId: "request-1",
        scope,
        type: "input.requested",
      }),
    );

    const terminal = vi.fn();
    const restored = await deserializeContext(await serializeContext(context));
    const terminals = createInstrumentationHooks([
      { events: { "input.resolved": terminal }, name: "sink" },
    ]);
    await contextStorage.run(restored, () =>
      terminals.publish({
        idempotencyKey: key,
        kind: "tool-approval",
        outcome: "approved",
        requestId: "request-1",
        scope,
        type: "input.resolved",
      }),
    );
    expect(terminal).not.toHaveBeenCalled();
  });

  it("ignores a timed-out handler's late state write", async () => {
    let resume!: () => void;
    const continued = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const hooks = createInstrumentationHooks(
      [
        {
          events: {
            "turn.started": async (_event, ctx) => {
              await continued;
              ctx.state.set("late");
            },
          },
          name: "slow",
        },
      ],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
      resume();
      await continued;
      await Promise.resolve();
      expect(instrumentationStateSlot("slow", key).get()).toBeUndefined();
    });
  });

  it("does not abandon an operation for a point-event timeout", async () => {
    const terminal = vi.fn();
    const hooks = createInstrumentationHooks(
      [
        {
          events: {
            "step.attempt.completed": terminal,
            "step.attempt.metadata": hang,
          },
          name: "slow-metadata",
        },
      ],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        providerMetadata: {},
        scope,
        type: "step.attempt.metadata",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
    });
    expect(terminal).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(
      "instrumentation provider timed out",
      expect.objectContaining({ boundary: "step.attempt.metadata", provider: "slow-metadata" }),
    );
  });
});

describe("provider dispatch groups", () => {
  const started = {
    idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
    rootSessionId: "session-1",
    sequence: 0,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started" as const,
  };
  const completed = {
    idempotencyKey: started.idempotencyKey,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed" as const,
  };

  it("starts every parallel handler before either is released", async () => {
    const first = deferred();
    const second = deferred();
    const order: string[] = [];
    const hooks = createInstrumentationHooks({
      parallel: [
        {
          events: {
            "turn.started": async () => {
              order.push("first:start");
              await first.promise;
              order.push("first:end");
            },
          },
          name: "first",
        },
        {
          events: {
            "turn.started": async () => {
              order.push("second:start");
              await second.promise;
              order.push("second:end");
            },
          },
          name: "second",
        },
      ],
    });

    await contextStorage.run(new ContextContainer(), async () => {
      const publication = hooks.publish(started);
      expect(order).toEqual(["first:start", "second:start"]);
      first.resolve();
      second.resolve();
      await publication;
    });
  });

  it("publishes one immutable snapshot to every dispatch phase", async () => {
    const observed: unknown[] = [];
    const mutableScope = { ...scope };
    const event: InstrumentationModelCallStartedEvent = {
      idempotencyKey: modelCallIdempotencyKey(mutableScope, 0),
      input: { messages: [{ content: "private", role: "user" }] },
      model: { modelId: "model", provider: "test" },
      scope: mutableScope,
      type: "model.call.started" as const,
    };
    const mutator = (snapshot: InstrumentationModelCallStartedEvent): void => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.scope)).toBe(true);
      expect(Object.isFrozen(snapshot.input)).toBe(true);
      expect(Reflect.set(snapshot, "idempotencyKey", "corrupted")).toBe(false);
      expect(Reflect.set(snapshot.scope, "turnId", "corrupted")).toBe(false);
    };
    const observer = (snapshot: InstrumentationModelCallStartedEvent): void => {
      observed.push(snapshot.idempotencyKey, snapshot.scope.turnId, snapshot.type);
    };
    const hooks = createInstrumentationHooks({
      parallel: [
        { events: { "model.call.started": mutator }, name: "mutator" },
        { events: { "model.call.started": observer }, name: "observer" },
      ],
      serialAfter: [{ events: { "model.call.started": observer }, name: "cleanup" }],
      serialBefore: [{ events: { "model.call.started": observer }, name: "framework" }],
    });

    await contextStorage.run(new ContextContainer(), () => hooks.publish(event));

    expect(observed).toEqual([
      event.idempotencyKey,
      scope.turnId,
      event.type,
      event.idempotencyKey,
      scope.turnId,
      event.type,
      event.idempotencyKey,
      scope.turnId,
      event.type,
    ]);
    expect(Object.isFrozen(event)).toBe(false);
    expect(mutableScope.turnId).toBe(scope.turnId);
  });

  it("reuses the frozen scope snapshot across publications", async () => {
    const observedScopes: InstrumentationAttemptScope[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: {
          "model.call.completed": (event) => void observedScopes.push(event.scope),
          "model.call.started": (event) => void observedScopes.push(event.scope),
        },
        name: "observer",
      },
    ]);
    const sharedScope = { ...scope };

    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        idempotencyKey: modelCallIdempotencyKey(sharedScope, 0),
        input: { messages: [] },
        model: { modelId: "model", provider: "test" },
        scope: sharedScope,
        type: "model.call.started",
      });
      await hooks.publish({
        content: [],
        finishReason: "stop",
        idempotencyKey: modelCallIdempotencyKey(sharedScope, 0),
        scope: sharedScope,
        type: "model.call.completed",
        usage: {},
      });
    });

    expect(observedScopes).toHaveLength(2);
    expect(observedScopes[0]).toBe(observedScopes[1]);
    expect(observedScopes[0]).not.toBe(sharedScope);
    expect(Object.isFrozen(observedScopes[0])).toBe(true);
  });

  it("uses one timeout window for concurrent handlers", async () => {
    vi.useFakeTimers();
    const fast = vi.fn();
    const hooks = createInstrumentationHooks(
      {
        parallel: [
          { events: { "turn.started": () => new Promise<void>(() => {}) }, name: "hangs-one" },
          { events: { "turn.started": fast }, name: "fast" },
          { events: { "turn.started": () => new Promise<void>(() => {}) }, name: "hangs-two" },
        ],
      },
      { handlerTimeoutMs: 10 },
    );

    try {
      await contextStorage.run(new ContextContainer(), async () => {
        const publication = hooks.publish(started);
        let settled = false;
        void publication.then(() => {
          settled = true;
        });
        expect(fast).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(9);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await publication;
        expect(settled).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues parallel delivery when another handler throws", async () => {
    const received = vi.fn();
    const hooks = createInstrumentationHooks({
      parallel: [
        {
          events: {
            "turn.started": () => {
              throw new Error("expected provider failure");
            },
          },
          name: "throws",
        },
        { events: { "turn.started": received }, name: "receives" },
      ],
    });

    await contextStorage.run(new ContextContainer(), () => hooks.publish(started));
    expect(received).toHaveBeenCalledOnce();
  });

  it("runs serial phases around the parallel publication", async () => {
    vi.useFakeTimers();
    const before = deferred();
    const order: string[] = [];
    const hooks = createInstrumentationHooks(
      {
        parallel: [
          {
            events: {
              "turn.started": () => {
                order.push("parallel");
                return new Promise<void>(() => {});
              },
            },
            name: "parallel",
          },
        ],
        serialAfter: [
          { events: { "turn.started": () => void order.push("after") }, name: "after" },
        ],
        serialBefore: [
          {
            events: {
              "turn.started": async () => {
                order.push("before:start");
                await before.promise;
                order.push("before:end");
              },
            },
            name: "before",
          },
        ],
      },
      { handlerTimeoutMs: 10 },
    );

    try {
      await contextStorage.run(new ContextContainer(), async () => {
        const publication = hooks.publish(started);
        expect(order).toEqual(["before:start"]);
        before.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(["before:start", "before:end", "parallel"]);
        await vi.advanceTimersByTimeAsync(10);
        await publication;
      });
      expect(order).toEqual(["before:start", "before:end", "parallel", "after"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs serial cleanup before rethrowing an unexpected parallel rejection", async () => {
    const failure = new Error("framework state failed");
    const cleanup = vi.fn();
    const broken = Object.defineProperty({ name: "broken" }, "events", {
      get: () => {
        throw failure;
      },
    }) as InstrumentationProviderDefinition;
    const hooks = createInstrumentationHooks({
      parallel: [broken],
      serialAfter: [{ events: { "turn.started": cleanup }, name: "cleanup" }],
    });

    await contextStorage.run(new ContextContainer(), async () => {
      await expect(hooks.publish(started)).rejects.toBe(failure);
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps durable state isolated between parallel providers", async () => {
    const observed = new Map<string, unknown>();
    const hooks = createInstrumentationHooks({
      parallel: [
        {
          events: {
            "turn.completed": (_event, ctx) => {
              observed.set("first", ctx.state.get());
            },
            "turn.started": (_event, ctx) => ctx.state.set("one"),
          },
          name: "first",
        },
        {
          events: {
            "turn.completed": (_event, ctx) => {
              observed.set("second", ctx.state.get());
            },
            "turn.started": (_event, ctx) => ctx.state.set("two"),
          },
          name: "second",
        },
      ],
    });

    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
    });
    expect(observed).toEqual(
      new Map([
        ["first", "one"],
        ["second", "two"],
      ]),
    );
  });

  it("suppresses only a timed-out provider terminal and revokes its late write", async () => {
    vi.useFakeTimers();
    const continuation = deferred();
    const unaffectedTerminal = vi.fn();
    const timedOutTerminal = vi.fn();
    const hooks = createInstrumentationHooks(
      {
        parallel: [
          {
            events: {
              "turn.completed": timedOutTerminal,
              "turn.started": async (_event, ctx) => {
                await continuation.promise;
                ctx.state.set("late");
              },
            },
            name: "times-out",
          },
          { events: { "turn.completed": unaffectedTerminal }, name: "unaffected" },
        ],
      },
      { handlerTimeoutMs: 10 },
    );

    try {
      await contextStorage.run(new ContextContainer(), async () => {
        const publication = hooks.publish(started);
        await vi.advanceTimersByTimeAsync(10);
        await publication;
        await hooks.publish(completed);
        continuation.resolve();
        await continuation.promise;
        await Promise.resolve();
        expect(instrumentationStateSlot("times-out", started.idempotencyKey).get()).toBeUndefined();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(timedOutTerminal).not.toHaveBeenCalled();
    expect(unaffectedTerminal).toHaveBeenCalledOnce();
  });

  it("keeps array input sequential", async () => {
    const first = deferred();
    const order: string[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: {
          "turn.started": async () => {
            order.push("first:start");
            await first.promise;
            order.push("first:end");
          },
        },
        name: "first",
      },
      { events: { "turn.started": () => void order.push("second") }, name: "second" },
    ]);

    await contextStorage.run(new ContextContainer(), async () => {
      const publication = hooks.publish(started);
      expect(order).toEqual(["first:start"]);
      first.resolve();
      await publication;
    });
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});

describe("capture", () => {
  it("reports content capture only when some provider asked for it", () => {
    expect(createInstrumentationHooks([{ name: "quiet" }]).capturesContent).toBe(false);
    expect(
      createInstrumentationHooks([{ capture: "metadata", name: "quiet" }, { name: "also-quiet" }])
        .capturesContent,
    ).toBe(false);
    expect(
      createInstrumentationHooks([{ name: "quiet" }, { capture: "content", name: "loud" }])
        .capturesContent,
    ).toBe(true);
    expect(
      createInstrumentationHooks({
        parallel: [{ capture: "content", name: "loud" }],
      }).capturesContent,
    ).toBe(true);
  });

  it("allows only structural provider metadata by default", async () => {
    const metadataOnly = vi.fn();
    const wantsContent = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "step.attempt.metadata": metadataOnly }, name: "metadata" },
      {
        capture: "content",
        events: { "step.attempt.metadata": wantsContent },
        name: "content",
      },
    ]);
    const providerMetadata = {
      gateway: {
        cost: "0.01",
        generationId: "generation-1",
        groundingSegments: ["private result"],
      },
      google: { searchQueries: ["private query"], thoughtSignature: "private signature" },
    };

    await hooks.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      providerMetadata,
      scope,
      type: "step.attempt.metadata",
    });

    const visible = metadataOnly.mock.calls[0]?.[0];
    expect(visible.providerMetadata).toEqual({
      gateway: { cost: "0.01", generationId: "generation-1" },
    });
    expect(Object.isFrozen(visible)).toBe(true);
    expect(Object.isFrozen(visible.providerMetadata)).toBe(true);
    expect(Object.isFrozen(visible.providerMetadata.gateway)).toBe(true);
    expect(wantsContent.mock.calls[0]?.[0].providerMetadata).toEqual(providerMetadata);
    expect(wantsContent.mock.calls[0]?.[0].providerMetadata).not.toBe(providerMetadata);
    expect(Object.isFrozen(wantsContent.mock.calls[0]?.[0].providerMetadata)).toBe(true);
  });

  it("withholds failure details from metadata providers", async () => {
    const metadataOnly = vi.fn();
    const wantsContent = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "action.failed": metadataOnly }, name: "metadata" },
      { capture: "content", events: { "action.failed": wantsContent }, name: "content" },
    ]);
    const error = { output: "private tool output", requestBody: "private request" };
    const actionScope = { ...scope };

    await hooks.publish({
      error,
      errorCode: "SUBAGENT_EXECUTION_FAILED",
      idempotencyKey: actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1"),
      outcome: "failed",
      scope: actionScope,
      type: "action.failed",
    });

    expect(metadataOnly.mock.calls[0]?.[0]).toMatchObject({
      error: undefined,
      errorCode: "SUBAGENT_EXECUTION_FAILED",
      outcome: "failed",
      type: "action.failed",
    });
    expect(Object.isFrozen(metadataOnly.mock.calls[0]?.[0])).toBe(true);
    expect(wantsContent.mock.calls[0]?.[0].error).toEqual(error);
    expect(wantsContent.mock.calls[0]?.[0].error).not.toBe(error);
    expect(Object.isFrozen(wantsContent.mock.calls[0]?.[0].error)).toBe(true);
  });

  it("keeps action outcome and usage when output content is withheld", async () => {
    const metadataOnly = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "action.completed": metadataOnly }, name: "metadata" },
    ]);
    await hooks.publish({
      acceptedAtMs: 1_234,
      idempotencyKey: actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1"),
      outcome: "completed",
      output: { output: "private result", type: "result" },
      scope,
      type: "action.completed",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    expect(metadataOnly.mock.calls[0]?.[0]).toMatchObject({
      acceptedAtMs: 1_234,
      outcome: "completed",
      output: { type: "result" },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("withholds input request and response content from metadata providers", async () => {
    const metadataEvents: unknown[] = [];
    const contentEvents: unknown[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: {
          "input.requested": (event) => void metadataEvents.push(event),
          "input.resolved": (event) => void metadataEvents.push(event),
        },
        name: "metadata",
      },
      {
        capture: "content",
        events: {
          "input.requested": (event) => void contentEvents.push(event),
          "input.resolved": (event) => void contentEvents.push(event),
        },
        name: "content",
      },
    ]);
    const idempotencyKey = inputIdempotencyKey(scope.sessionId, scope.turnId, "request-1");

    await hooks.publish({
      action: { callId: "call-1", name: "weather" },
      idempotencyKey,
      kind: "tool-approval",
      request: { prompt: "Approve private input?" },
      requestId: "request-1",
      scope,
      type: "input.requested",
    });
    await hooks.publish({
      idempotencyKey,
      kind: "tool-approval",
      outcome: "denied",
      requestId: "request-1",
      response: { optionId: "deny", text: "private reason" },
      scope,
      type: "input.resolved",
    });

    expect(metadataEvents).toMatchObject([
      { request: undefined, type: "input.requested" },
      { response: undefined, type: "input.resolved" },
    ]);
    expect(contentEvents).toMatchObject([
      { request: { prompt: "Approve private input?" }, type: "input.requested" },
      {
        response: { optionId: "deny", text: "private reason" },
        type: "input.resolved",
      },
    ]);
  });

  it("freezes one stripped projection shared by metadata providers", async () => {
    const observed = vi.fn();
    const content = vi.fn();
    const mutator = vi.fn((event: InstrumentationToolCallCompletedEvent) => {
      expect(Reflect.set(event, "finishReason", "corrupted")).toBe(false);
      expect(Reflect.set(event.output, "type", "error")).toBe(false);
    });
    const hooks = createInstrumentationHooks({
      parallel: [
        { events: { "tool.call.completed": mutator }, name: "first" },
        { events: { "tool.call.completed": observed }, name: "second" },
        {
          capture: "content",
          events: { "tool.call.completed": content },
          name: "content",
        },
      ],
    });

    const event = {
      idempotencyKey: toolCallIdempotencyKey(scope, "call-1", 0),
      output: { output: "private", type: "result" },
      scope,
      type: "tool.call.completed",
    } as const;
    await hooks.publish(event);

    expect(observed.mock.calls[0]?.[0].output).toEqual({ type: "result" });
    expect(observed.mock.calls[0]?.[0]).toBe(mutator.mock.calls[0]?.[0]);
    expect(Object.isFrozen(observed.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(observed.mock.calls[0]?.[0].output)).toBe(true);
    const contentEvent = content.mock.calls[0]?.[0];
    expect(contentEvent).not.toBe(event);
    expect(contentEvent).toEqual(event);
    expect(contentEvent.output).toEqual({ output: "private", type: "result" });
    expect(Object.isFrozen(contentEvent)).toBe(true);
    expect(Object.isFrozen(contentEvent.output)).toBe(true);
    expect(Object.isFrozen(contentEvent.scope)).toBe(true);
    expect(Object.isFrozen(event)).toBe(false);
  });
});
