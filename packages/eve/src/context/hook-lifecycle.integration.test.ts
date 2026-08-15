import { describe, expect, it } from "vitest";

import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { ContextContainer, contextStorage } from "./container.js";
import { dispatchStreamEventHooks } from "./hook-lifecycle.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { ContinuationTokenKey, SessionIdKey, SessionKey } from "./keys.js";

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
  it("invokes typed then wildcard subscribers and propagates errors", async () => {
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

    const brokenRegistry = createRuntimeHookRegistry([
      hook("broken", {
        events: {
          "session.completed": async () => {
            throw new Error("event hook boom");
          },
        },
      }),
    ]);
    await expect(
      contextStorage.run(ctx, () =>
        dispatchStreamEventHooks({
          ctx,
          registry: brokenRegistry,
          event: stampTestEvent({ type: "session.completed" }),
        }),
      ),
    ).rejects.toThrow(/event hook boom/);
  });
});
