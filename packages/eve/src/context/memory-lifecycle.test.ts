import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  dispatchMemoryCompactionCompleted,
  dispatchMemoryCompactionRequested,
  dispatchMemoryTurnCompleted,
  dispatchMemoryTurnStarted,
  drainMemoryCommit,
  prepareMemoryCompaction,
  prepareMemoryPreamble,
} from "#context/memory-lifecycle.js";
import { AuthKey, SessionIdKey, SessionKey, TurnMemoryLocksKey } from "#context/keys.js";
import {
  defineMemory,
  type MemoryDefinition,
  type MemoryTurnCompletedContext,
} from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import {
  applyMemoryRecallBatches,
  createMemoryLock,
  validateMemoryRecallResult,
} from "#shared/memory-state.js";

const turnStarted = {
  data: { sequence: 0, turnId: "turn_0" },
  type: "turn.started" as const,
};

function createContext() {
  const auth = {
    attributes: {},
    authenticator: "test",
    principalId: "user_1",
    principalType: "user",
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, auth);
  ctx.set(SessionIdKey, "session_1");
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: auth },
    sessionId: "session_1",
    turn: { id: "turn_0", sequence: 0 },
  });
  return ctx;
}

function memory(slot: string, definition: MemoryDefinition): ResolvedMemoryDefinition {
  return {
    ...defineMemory(definition),
    logicalPath: `memory/${slot}.ts`,
    slot,
    sourceId: `memory/${slot}.ts`,
    sourceKind: "module",
    visibility: definition.visibility ?? "scope",
  };
}

describe("memory lifecycle", () => {
  it("ignores turn events that are not an authored turn preamble", async () => {
    const ctx = createContext();
    const recall = vi.fn(async () => null);

    const projected = await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryTurnStarted({
          appRoot: "/app",
          ctx,
          event: turnStarted,
          memories: [
            memory("profile", {
              provider: { recall: { "turn.started": recall } },
              scope: "user_1",
            }),
          ],
          nodeId: "__root__",
        }),
    );

    expect(projected).toEqual([]);
    expect(recall).not.toHaveBeenCalled();
    expect(ctx.get(TurnMemoryLocksKey)).toBeUndefined();
  });

  it("locks every scope before recalling slots against one pre-recall view", async () => {
    const ctx = createContext();
    const events: string[] = [];
    const seen: ModelMessage[][] = [];
    const memories = ["bravo", "alpha"].map((slot) =>
      memory(slot, {
        namespace: async () => {
          events.push(`${slot}:namespace`);
          return "app";
        },
        provider: {
          recall: {
            "turn.started": async (context) => {
              events.push(`${slot}:recall`);
              seen.push([...context.messages]);
              return { messages: [{ content: `${slot} memory`, id: "item" }] };
            },
          },
        },
        scope: async () => {
          events.push(`${slot}:scope`);
          return "user_1";
        },
      }),
    );
    const history: ModelMessage[] = [{ content: "prior", role: "assistant" }];
    const input: ModelMessage[] = [{ content: "current", role: "user" }];
    prepareMemoryPreamble(ctx, { history, input });

    const projected = await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryTurnStarted({
          appRoot: "/app",
          ctx,
          event: turnStarted,
          memories,
          nodeId: "__root__",
        }),
    );
    const commit = drainMemoryCommit(ctx)!;

    expect(events.indexOf("alpha:recall")).toBeGreaterThan(events.indexOf("bravo:namespace"));
    expect(events.indexOf("bravo:recall")).toBeGreaterThan(events.indexOf("alpha:namespace"));
    expect(seen).toEqual([[history[0]!], [history[0]!]]);
    expect(projected).toEqual([
      history[0],
      { content: "alpha memory", role: "user" },
      { content: "bravo memory", role: "user" },
      input[0],
    ]);
    expect(JSON.stringify(commit.history)).toContain("eve.memory");
  });

  it("commits no slot when one turn-wide recall batch is invalid", async () => {
    const ctx = createContext();
    const valid = vi.fn(async () => ({ messages: [{ content: "valid" }] }));
    const invalid = vi.fn(async () => ({ messages: [{ content: "   " }] }));
    prepareMemoryPreamble(ctx, { history: [], input: [] });

    await expect(
      contextStorage.run(
        ctx,
        async () =>
          await dispatchMemoryTurnStarted({
            appRoot: "/app",
            ctx,
            event: turnStarted,
            memories: [
              memory("alpha", {
                provider: { recall: { "turn.started": valid } },
                scope: "user_1",
              }),
              memory("bravo", {
                provider: { recall: { "turn.started": invalid } },
                scope: "user_1",
              }),
            ],
            nodeId: "__root__",
          }),
      ),
    ).rejects.toThrow("content must be non-blank");

    expect(valid).toHaveBeenCalledOnce();
    expect(invalid).toHaveBeenCalledOnce();
    expect(drainMemoryCommit(ctx)).toBeUndefined();
  });

  it("resolves scope before namespace and skips the entire disabled slot", async () => {
    const ctx = createContext();
    const namespace = vi.fn(() => "app");
    const recall = vi.fn(async () => null);
    prepareMemoryPreamble(ctx, { history: [], input: [] });

    await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryTurnStarted({
          appRoot: "/app",
          ctx,
          event: turnStarted,
          memories: [
            memory("profile", {
              namespace,
              provider: { recall: { "turn.started": recall } },
              scope: null,
            }),
          ],
          nodeId: "__root__",
        }),
    );

    expect(namespace).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(drainMemoryCommit(ctx)?.history).toEqual([]);
  });

  it("captures only the settled projected history for a successful turn", async () => {
    const ctx = createContext();
    const capture = vi.fn(async (_context: MemoryTurnCompletedContext) => {});
    const definition = memory("profile", {
      provider: {
        capture: { "turn.completed": capture },
        recall: {
          "turn.started": async () => ({
            messages: [{ content: "remembered", id: "profile" }],
          }),
        },
      },
      scope: "user_1",
    });
    prepareMemoryPreamble(ctx, { history: [], input: [{ content: "hello", role: "user" }] });
    await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryTurnStarted({
          appRoot: "/app",
          ctx,
          event: turnStarted,
          memories: [definition],
          nodeId: "__root__",
        }),
    );
    const commit = drainMemoryCommit(ctx)!;
    const settled = [
      ...commit.history,
      { content: "hello", role: "user" as const },
      { content: "hi", role: "assistant" as const },
    ];

    await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryTurnCompleted({
          ctx,
          event: { data: { sequence: 0, turnId: "turn_0" }, type: "turn.completed" },
          memories: [definition],
          messages: settled,
        }),
    );

    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      messages: [
        { content: "remembered", role: "user" },
        { content: "hello", role: "user" },
        { content: "hi", role: "assistant" },
      ],
      operationId: "eve-memory-operation-v1:session_1:0:turn_0:turn.completed:profile",
    });
    expect(capture.mock.calls[0]?.[0]).not.toHaveProperty("phase");
    expect(capture.mock.calls[0]?.[0]).not.toHaveProperty("compaction");
    expect(JSON.stringify(capture.mock.calls[0]?.[0].messages)).not.toContain("eve.memory");
  });

  it("captures before compaction and recalls again after the checkpoint", async () => {
    const ctx = createContext();
    const phases: string[] = [];
    const definition = memory("profile", {
      provider: {
        capture: {
          "compaction.requested": async (context) => {
            phases.push("compaction.requested");
            expect(context).not.toHaveProperty("phase");
            expect(context.compaction).toEqual({
              modelId: "openai/test",
              usageInputTokens: 100,
            });
            expect(JSON.stringify(context.messages)).not.toContain("eve.memory");
          },
        },
        recall: {
          "turn.started": async () => ({
            messages: [{ content: "old profile", id: "profile" }],
          }),
          "compaction.completed": async (context) => {
            phases.push("compaction.completed");
            expect(context).not.toHaveProperty("phase");
            expect(context.compaction).toEqual({ modelId: "openai/test" });
            return {
              messages: [{ content: "new profile", id: "profile" }],
            };
          },
        },
      },
      scope: "user_1",
    });
    const memoryLock = createMemoryLock({
      namespace: "app",
      scope: "user_1",
      slot: "profile",
      turn: { id: "turn_0", input: [], sequence: 0 },
      visibility: "scope",
    });
    const recalled = applyMemoryRecallBatches({
      batches: [
        {
          lock: memoryLock,
          messages: validateMemoryRecallResult(
            { messages: [{ content: "old profile", id: "profile" }] },
            "profile",
          ),
          operationId: "initial",
        },
      ],
      history: [{ content: "ordinary", role: "user" }],
      state: undefined,
    });
    ctx.set(TurnMemoryLocksKey, { profile: memoryLock });
    const requested = {
      data: {
        modelId: "openai/test",
        sequence: 0,
        sessionId: "session_1",
        turnId: "turn_0",
        usageInputTokens: 100,
      },
      type: "compaction.requested" as const,
    };
    prepareMemoryCompaction(ctx, { history: recalled.history, state: recalled.state });

    await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryCompactionRequested({
          appRoot: "/app",
          ctx,
          event: requested,
          memories: [definition],
          messages: [{ content: "ordinary", role: "user" }],
          nodeId: "__root__",
        }),
    );
    prepareMemoryCompaction(ctx, { history: recalled.history, state: recalled.state });
    const projected = await contextStorage.run(
      ctx,
      async () =>
        await dispatchMemoryCompactionCompleted({
          ctx,
          event: {
            data: {
              modelId: "openai/test",
              sequence: 0,
              sessionId: "session_1",
              turnId: "turn_0",
            },
            type: "compaction.completed",
          },
          memories: [definition],
          messages: [],
        }),
    );

    expect(phases).toEqual(["compaction.requested", "compaction.completed"]);
    expect(projected).toEqual([
      { content: "ordinary", role: "user" },
      { content: "new profile", role: "user" },
    ]);
    expect(drainMemoryCommit(ctx)?.history).toHaveLength(3);
  });
});
