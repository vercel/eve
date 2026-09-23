import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";

import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import {
  createSessionFailedEvent,
  createStepStartedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { ContextContainer, contextStorage } from "./container.js";
import { dispatchStreamEventHooks } from "./hook-lifecycle.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { ContinuationTokenKey, SandboxKey, SessionIdKey, SessionKey } from "./keys.js";

const records: LogRecord[] = [];
beforeEach(() => {
  records.length = 0;
  setLogRecordSubscriber((record) => records.push(record));
});
afterEach(() => setLogRecordSubscriber(undefined));

function createMockBundle(): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: { config: { name: "test-agent" }, skills: [] } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: {
      id: "test-agent",
      instructions: [],
      model: { id: "openai/gpt-5.5" },
      tools: [],
      workspaceSpec: { rootEntries: [] },
    },
  };
}

function buildCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "session_test");
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session_test",
    turn: { id: "turn_0", sequence: 0 },
  });
  ctx.set(ContinuationTokenKey, "test:continuation");
  ctx.set(ChannelKey, { kind: "mock" } as never);
  ctx.set(BundleKey, createMockBundle());
  return ctx;
}

function hook(slug: string, hooks: Partial<ResolvedHookDefinition>): ResolvedHookDefinition {
  return {
    events: hooks.events ?? {},
    exportName: undefined,
    logicalPath: `hooks/${slug}.ts`,
    slug,
    sourceId: `hooks/${slug}.ts`,
    sourceKind: "module",
  };
}

describe("dispatchStreamEventHooks", () => {
  it("invokes typed then wildcard subscribers", async () => {
    const calls: string[] = [];
    const registry = createRuntimeHookRegistry([
      hook("audit", {
        events: {
          "session.completed": async (_event, hookContext) => {
            expect(hookContext.channel.continuationToken).toBe("test:continuation");
            calls.push("typed");
          },
        },
      }),
      hook("metrics", {
        events: {
          "*": async (event) => {
            calls.push(`wildcard:${(event as UnstampedMessageStreamEvent).type}`);
          },
        },
      }),
    ]);
    const ctx = buildCtx();

    await contextStorage.run(ctx, () =>
      dispatchStreamEventHooks({
        ctx,
        registry,
        event: stampTestEvent({ type: "session.completed" }),
      }),
    );
    expect(calls).toEqual(["typed", "wildcard:session.completed"]);

    expect(records).toEqual([]);
  });

  it.each([
    createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
    createStepStartedEvent({ sequence: 0, turnId: "turn_0", stepIndex: 0, modelId: "test" }),
    { type: "session.completed" } as const,
    createSessionFailedEvent({
      code: "TEST_FAILURE",
      message: "Runtime failure",
      sessionId: "session_test",
    }),
  ])("continues typed and wildcard subscribers after failures for $type", async (event) => {
    const calls: string[] = [];
    const registry = createRuntimeHookRegistry([
      hook("broken-typed", {
        events: {
          [event.type]: () => {
            calls.push("broken-typed");
            throw new Error("typed hook failed");
          },
        },
      }),
      hook("healthy-typed", {
        events: {
          [event.type]: () => {
            calls.push("healthy-typed");
          },
        },
      }),
      hook("broken-wildcard", {
        events: {
          "*": async () => {
            calls.push("broken-wildcard");
            throw new Error("wildcard hook failed");
          },
        },
      }),
      hook("healthy-wildcard", {
        events: {
          "*": () => {
            calls.push("healthy-wildcard");
          },
        },
      }),
    ]);
    const ctx = buildCtx();
    const stamped = stampTestEvent(event);
    await contextStorage.run(ctx, () =>
      dispatchStreamEventHooks({ ctx, registry, event: stamped }),
    );
    expect(calls).toEqual(["broken-typed", "healthy-typed", "broken-wildcard", "healthy-wildcard"]);
    expect(records).toMatchObject([
      {
        level: "error",
        fields: {
          hook: "broken-typed",
          subscription: event.type,
          eventId: stamped.meta.id,
          eventType: event.type,
          sessionId: "session_test",
          error: { message: expect.stringMatching(/^(?:Error: )?typed hook failed$/) },
        },
      },
      {
        level: "error",
        fields: {
          hook: "broken-wildcard",
          subscription: "*",
          eventId: stamped.meta.id,
          eventType: event.type,
          sessionId: "session_test",
          error: { message: expect.stringMatching(/^(?:Error: )?wildcard hook failed$/) },
        },
      },
    ]);
  });

  it("forwards ctx.cancel() without skipping later subscribers", async () => {
    const calls: string[] = [];
    const registry = createRuntimeHookRegistry([
      hook("gate", {
        events: {
          "turn.started": (_event, hookContext) => {
            calls.push("gate");
            hookContext.cancel();
          },
        },
      }),
      hook("audit", { events: { "*": () => void calls.push("audit") } }),
    ]);
    const ctx = buildCtx();
    await contextStorage.run(ctx, () =>
      dispatchStreamEventHooks({
        cancelTurn: () => calls.push("cancelTurn"),
        ctx,
        registry,
        event: stampTestEvent(createTurnStartedEvent({ sequence: 0, turnId: "turn_0" })),
      }),
    );
    expect(calls).toEqual(["gate", "cancelTurn", "audit"]);
    expect(records).toEqual([]);
  });

  it("warns and ignores ctx.cancel() when the event cannot cancel a turn", async () => {
    const registry = createRuntimeHookRegistry([
      hook("gate", {
        events: { "session.completed": (_event, hookContext) => hookContext.cancel() },
      }),
    ]);
    const ctx = buildCtx();
    const stamped = stampTestEvent({ type: "session.completed" });
    await contextStorage.run(ctx, () =>
      dispatchStreamEventHooks({ ctx, registry, event: stamped }),
    );
    expect(records).toMatchObject([
      {
        level: "warn",
        message: "ctx.cancel() ignored: the event is not part of a running turn",
        fields: {
          hook: "gate",
          eventId: stamped.meta.id,
          eventType: "session.completed",
          sessionId: "session_test",
        },
      },
    ]);
  });

  it("still propagates runtime context setup failures", async () => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createMockBundle());
    const registry = createRuntimeHookRegistry([hook("audit", { events: { "*": () => {} } })]);
    await expect(
      contextStorage.run(ctx, () =>
        dispatchStreamEventHooks({
          ctx,
          registry,
          event: stampTestEvent({ type: "session.completed" }),
        }),
      ),
    ).rejects.toThrow('Context key "eve.session" is not set.');
    expect(records).toEqual([]);
  });

  it("can delete the runtime sandbox from a session.completed hook", async () => {
    let deletions = 0;
    const sandbox = mockSandbox({
      delete: () => {
        deletions += 1;
      },
    });
    const registry = createRuntimeHookRegistry([
      hook("cleanup", {
        events: {
          "session.completed": async (_event, hookContext) => {
            const live = await hookContext.getSandbox();
            await live.delete();
          },
        },
      }),
    ]);
    const ctx = buildCtx();
    ctx.set(SandboxKey, sandbox.access);

    await contextStorage.run(ctx, () =>
      dispatchStreamEventHooks({
        ctx,
        registry,
        event: stampTestEvent({ type: "session.completed" }),
      }),
    );

    expect(deletions).toBe(1);
  });
});
