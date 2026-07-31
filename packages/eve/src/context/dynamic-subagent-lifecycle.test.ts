import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  buildDynamicSubagentTools,
  dispatchDynamicSubagentEvent,
  isDynamicSubagentAvailable,
  refreshDynamicSessionSubagentsForRuntimeRevision,
} from "#context/dynamic-subagent-lifecycle.js";
import { SessionDynamicSubagentRuntimeRevisionKey, SessionIdKey } from "#context/keys.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";

describe("dynamic subagent lifecycle", () => {
  it("omits a subagent when its resolver returns null", async () => {
    const ctx = createContext();
    const { resolver } = createResolver({ handler: () => null });

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
    expect(isDynamicSubagentAvailable(ctx, resolver.nodeId)).toBe(false);
  });

  it("exposes a subagent when its resolver returns the fallback definition", async () => {
    const ctx = createContext();
    const created = createResolver();
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: { "session.started": () => created.fallback },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toMatchObject([
      {
        description: "Research the request.",
        name: "researcher",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      },
    ]);
    expect(isDynamicSubagentAvailable(ctx, resolver.nodeId)).toBe(true);
  });

  it("lets a turn-scoped null hide a session-scoped selection", async () => {
    const ctx = createContext();
    const created = createResolver({
      eventNames: ["session.started", "turn.started"],
    });
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () => created.fallback,
        "turn.started": () => null,
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(buildDynamicSubagentTools(ctx)).toHaveLength(1);

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }),
      messages: [],
      resolvers: [resolver],
    });
    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
    expect(isDynamicSubagentAvailable(ctx, resolver.nodeId)).toBe(false);
  });

  it("omits a mismatched non-null agent definition", async () => {
    const ctx = createContext();
    const { resolver } = createResolver({
      handler: () =>
        defineAgent({
          description: "A different definition.",
          model: "openai/gpt-5.5",
        }),
    });

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
  });

  it("refreshes session availability once per runtime revision", async () => {
    const ctx = createContext();
    const created = createResolver();
    const handler = vi.fn(() => created.fallback);
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: { "session.started": handler },
    };

    await refreshDynamicSessionSubagentsForRuntimeRevision({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
      runtimeRevision: "deployment:one",
    });
    await refreshDynamicSessionSubagentsForRuntimeRevision({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
      runtimeRevision: "deployment:one",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(ctx.get(SessionDynamicSubagentRuntimeRevisionKey)).toBe("deployment:one");
    expect(buildDynamicSubagentTools(ctx)).toHaveLength(1);
  });
});

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "session-1");
  return ctx;
}

function createResolver(
  input: {
    readonly eventNames?: readonly string[];
    readonly handler?: () => unknown;
  } = {},
): {
  readonly fallback: ReturnType<typeof defineAgent>;
  readonly resolver: ResolvedDynamicSubagentResolver;
} {
  const fallback = defineAgent({
    description: "Research the request.",
    model: "openai/gpt-5.5",
  });
  const eventNames = input.eventNames ?? ["session.started"];
  const handler = input.handler ?? (() => null);

  return {
    fallback,
    resolver: {
      eventNames,
      events: Object.fromEntries(eventNames.map((eventName) => [eventName, handler])),
      fallback,
      logicalPath: "agent.ts",
      nodeId: "subagents/researcher",
      prepared: {
        description: fallback.description!,
        inputSchema: { type: "object" },
        kind: "subagent",
        logicalPath: "subagents/researcher",
        name: "researcher",
        nodeId: "subagents/researcher",
        sourceId: "subagents/researcher",
      },
      sourceId: "agent.ts",
      sourceKind: "module",
    },
  };
}
