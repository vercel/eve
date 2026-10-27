import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  SessionIdKey,
  SessionKey,
  StaticModelReferenceKey,
} from "#context/keys.js";
import { resolveApprovalPolicy, type ApprovalContext } from "#approval/definition.js";
import { evaluateApproval, type ApprovalMemory } from "#approval/evaluation.js";
import type { ApprovalDecision } from "#approval/status.js";
import { session as publicSession } from "#protocol/session-projection/public-view.js";
import { once } from "#tools/approval/policies.js";
import { z } from "#compiled/zod/index.js";
import type { DynamicContext } from "#dynamic/definition.js";
import {
  enterSessionProjection,
  enterSessionProjectionAt,
} from "#harness/session-machine/current.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { foldLine } from "#protocol/session-projection/fold.js";
import type { HookContext } from "#public/definitions/hook.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineTool } from "#tools/definition.js";
import { runApprovedCalls } from "#harness/hitl/approved-calls.js";
import { takeCompactRequest, takeTurnFailure } from "./intents.js";
import { takeUserInstructionMessages } from "./kinds/instructions.js";
import { dynamicTools } from "./kinds/tool.js";
import { evaluateValues, isReactionFailedError, restoreReactions, runReactions } from "./runner.js";
import { MEMOS_CAP, forgetSessionLive, memoBytes, readReactionsState, slotsOf } from "./state.js";

const user = (content: string): ModelMessage => ({ content, role: "user" });

function written(
  line: number,
  type = "turn.started",
  data: object = {},
  progress = false,
  view: object = initialSessionProjection().view,
) {
  return [
    {
      event: {
        data,
        meta: { at: `2026-01-01T00:00:0${line}.000Z`, position: { index: 0, line } },
        type,
      },
      position: { index: 0, line },
      progress,
      view,
    },
  ] as never;
}

type Evaluate = (ctx: DynamicContext) => unknown;

/** A session whose bundle declares one dynamic tool definition, and optionally hooks and more. */
function session(
  evaluate: Evaluate,
  hooks: readonly { readonly slug: string; readonly events: object }[] = [],
  instructions: readonly Evaluate[] = [],
) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(BundleKey, {
    nodeId: "root",
    resolvedAgent: {
      dynamicInstructionsResolvers: instructions.map((fn, index) => ({
        evaluate: fn,
        logicalPath: `instructions/brief-${index}.ts`,
        slug: `brief-${index}`,
        sourceId: `instructions/brief-${index}.ts`,
      })),
      dynamicSkillResolvers: [],
      dynamicToolResolvers: [
        { evaluate, logicalPath: "tools/count.ts", slug: "count", sourceId: "tools/count.ts" },
      ],
      hooks: hooks.map((hook) => ({ ...hook, logicalPath: `hooks/${hook.slug}.ts` })),
      memories: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: { id: "agent" },
  } as never);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: ctx.get(SessionIdKey),
  } as never);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

/** Runs a commit's reactions inside the session's context, which hooks read. */
async function commit(ctx: ContextContainer, input: Parameters<typeof runReactions>[1]) {
  await contextStorage.run(ctx, async () => await runReactions(ctx, input));
}

/** Evaluates the values before a model call, inside the session's context. */
async function beforeCall(ctx: ContextContainer, conversation: readonly ModelMessage[] = []) {
  await contextStorage.run(ctx, async () => await evaluateValues(ctx, { conversation }));
}

const countTool = (count: unknown) =>
  defineTool({
    description: `Count ${String(count)}.`,
    execute: async () => count,
    inputSchema: {},
  });

/** A definition whose memo, keyed by the conversation's length, logs each run. */
function counted(runs: unknown[], evaluations: unknown[] = []): Evaluate {
  return async (ctx) => {
    const length = (await ctx.messages()).length;
    evaluations.push(length);
    return countTool(
      await ctx.memo(length, () => {
        runs.push(length);
        return length;
      }),
    );
  };
}

const noTools: Evaluate = () => null;

// A projection whose session started and whose turn-1 is running.
const turnRunning = (ctx: ContextContainer) => {
  const projection = initialSessionProjection();
  foldLine(
    projection.view,
    {
      at: "2026-01-01T00:00:00.000Z",
      facts: [
        {
          data: { cause: { deliveryId: "d_1" }, follows: null, turnId: "turn-1" },
          type: "turn.started",
        },
      ],
    },
    projection.view.position,
  );
  enterSessionProjectionAt(ctx, projection);
};

afterEach(() => {
  delete process.env.EVE_DEV;
  delete process.env.EVE_LOG_LEVEL;
});

describe("evaluateValues", () => {
  it("evaluates every model call, and runs a memo once per key", async () => {
    const runs: unknown[] = [];
    const evaluations: unknown[] = [];
    const ctx = session(counted(runs, evaluations));

    await beforeCall(ctx, [user("a")]);
    await beforeCall(ctx, [user("a")]);
    await beforeCall(ctx, [user("a"), user("b")]);

    expect(evaluations).toEqual([1, 1, 2]);
    expect(runs).toEqual([1, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
  });

  it("keeps only the keys the latest evaluation used, so a key that comes back runs again", async () => {
    const runs: unknown[] = [];
    const ctx = session(counted(runs));

    await beforeCall(ctx, [user("a")]);
    await beforeCall(ctx, [user("a"), user("b")]);
    await beforeCall(ctx, [user("a")]);

    expect(runs).toEqual([1, 2, 1]);
  });

  it("leaves values alone after commits, which only hooks react to", async () => {
    const runs: unknown[] = [];
    const ctx = session(counted(runs));

    await commit(ctx, { conversation: [user("a")], written: written(1) });

    expect(runs).toEqual([]);
    expect(readReactionsState(ctx).latest).toMatchObject({ "*": 1, "turn.started": 1 });
    expect(readReactionsState(ctx).at).toBe("2026-01-01T00:00:01.000Z");
  });

  it("builds code again in a fresh process from its memos, without running them", async () => {
    const runs: unknown[] = [];
    const evaluations: unknown[] = [];
    const ctx = session(counted(runs, evaluations));
    await beforeCall(ctx, [user("a"), user("b")]);

    forgetSessionLive(ctx.get(SessionIdKey)!);
    expect(dynamicTools(ctx)).toEqual([]);
    await contextStorage.run(ctx, () =>
      restoreReactions(ctx, { conversation: [user("a"), user("b")] }),
    );

    expect(runs).toEqual([2]);
    expect(evaluations).toEqual([2, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
  });

  it("fails a parked call when a cold rebuild changes its tool, and offers the new tool", async () => {
    let label = "before";
    const executed: string[] = [];
    const ctx = session(() =>
      defineTool({
        description: `Report ${label}.`,
        execute: async () => executed.push(label),
        inputSchema: {},
      }),
    );
    await beforeCall(ctx);
    const offered = dynamicTools(ctx)[0]!;

    label = "after";
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await contextStorage.run(ctx, () => restoreReactions(ctx));
    const rebuilt = dynamicTools(ctx)[0]!;
    const result = await runApprovedCalls({
      abortSignal: undefined,
      approvals: [
        { call: { callId: "call-1", input: {}, toolName: "count", version: offered.version } },
      ],
      messages: [],
      publish: async () => {},
      tools: new Map([["count", rebuilt]]),
      view: () => ({ projection: initialSessionProjection() }),
    });

    expect(executed).toEqual([]);
    expect(result.settled[0]?.part.output).toEqual({
      type: "error-text",
      value:
        'The tool "count" changed since it was offered, so the call didn\'t run. If the task still needs it, request it again.',
    });
    expect(rebuilt.description).toBe("Report after.");
    expect(rebuilt.version).not.toBe(offered.version);
  });

  it("versions a tool by the memo results it was built from", async () => {
    let tenant = "a";
    const ctx = session(async (ctx) => {
      const id = await ctx.memo(tenant, () => tenant);
      return defineTool({ description: "Look up.", execute: async () => id, inputSchema: {} });
    });
    await beforeCall(ctx);
    const first = dynamicTools(ctx)[0]!.version;
    await beforeCall(ctx);
    expect(dynamicTools(ctx)[0]!.version).toBe(first);

    tenant = "b";
    await beforeCall(ctx);
    expect(dynamicTools(ctx)[0]!.version).not.toBe(first);
  });

  it("rebuilds a per-tool once policy in a fresh process", async () => {
    const ctx = session(() =>
      defineTool({
        approval: once(),
        description: "Deploy Alice's release.",
        execute: async () => "deployed",
        inputSchema: z.object({ scope: z.string() }),
      }),
    );
    await beforeCall(ctx);
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await contextStorage.run(ctx, () => restoreReactions(ctx));

    const tool = dynamicTools(ctx)[0]!;
    const policy = resolveApprovalPolicy(tool.approval!);
    const context: ApprovalContext = {
      abortSignal: new AbortController().signal,
      callId: "call-1",
      getSandbox: async () => {
        throw new Error("The policy doesn't use a sandbox.");
      },
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn-1", sequence: 0 },
      },
      toolInput: { scope: "dev" },
      toolName: tool.name,
    };
    const asked = await evaluateApproval(policy, context);
    expect(asked).toMatchObject({ awaitsPerson: true, remember: { key: expect.any(String) } });
    const memory: ApprovalMemory = {
      pending: [],
      remembered: { [asked.remember!.key]: { interactionId: "approval-1", outcome: "accepted" } },
    };
    const approved: ApprovalDecision = { denied: false, clearedBy: { policy: "approval" } };
    expect(await evaluateApproval(policy, { ...context }, { memory })).toEqual(approved);
    expect(
      await evaluateApproval(policy, { ...context, toolInput: { scope: "prod" } }, { memory }),
    ).toEqual(approved);
  });

  it("installs the code each evaluation builds, even when what the model is offered is unchanged", async () => {
    const executed: string[] = [];
    const ctx = session(async (ctx) => {
      const tenant = String((await ctx.messages()).at(-1)?.content);
      return defineTool({
        description: "Forget a memory.",
        execute: async () => executed.push(tenant),
        inputSchema: {},
      });
    });
    await beforeCall(ctx, [user("tenant-a")]);
    await beforeCall(ctx, [user("tenant-b")]);

    await contextStorage.run(ctx, () => dynamicTools(ctx)[0]!.execute!({}, {} as never));
    expect(executed).toEqual(["tenant-b"]);
  });

  it("discards memos on a move to another deployment, and keeps them otherwise", async () => {
    process.env.EVE_LOG_LEVEL = "debug";
    const logs = captureLogRecords();
    const runs: unknown[] = [];
    const ctx = session(counted(runs));
    await contextStorage.run(ctx, () => restoreReactions(ctx, { revision: "r1" }));
    await beforeCall(ctx, [user("a")]);
    await contextStorage.run(ctx, () => restoreReactions(ctx, { revision: "r1" }));
    await beforeCall(ctx, [user("a")]);
    expect(runs).toEqual([1]);

    await contextStorage.run(ctx, () =>
      restoreReactions(ctx, { conversation: [user("a")], revision: "r2" }),
    );
    await beforeCall(ctx, [user("a")]);

    expect(runs).toEqual([1, 1]);
    const memoRuns = logs.records.filter(({ message }) => message === "Ran a memo");
    expect(memoRuns.map(({ fields }) => fields?.reason)).toEqual(["new key", "deployment change"]);
    expect(memoRuns[0]?.fields).toMatchObject({ file: "tools/count.ts", key: expect.any(String) });
    expect(JSON.stringify(memoRuns)).not.toContain('"key":1');
  });

  it("drops the slot of a definition a new deployment removed", async () => {
    const policy: Evaluate = () => defineInstructions({ content: "Policy." });
    const ctx = session(counted([]), [], [policy]);
    await beforeCall(ctx, [user("a")]);
    expect(slotsOf(ctx, "instructions")).toHaveLength(1);

    const bundle = ctx.get(BundleKey) as { resolvedAgent: object };
    ctx.set(BundleKey, {
      ...bundle,
      resolvedAgent: { ...bundle.resolvedAgent, dynamicInstructionsResolvers: [] },
    } as never);
    await contextStorage.run(ctx, () =>
      restoreReactions(ctx, { conversation: [user("a")], revision: "r2" }),
    );

    expect(slotsOf(ctx, "instructions")).toEqual([]);
    expect(slotsOf(ctx, "tool")).toHaveLength(1);
  });

  it("fails without changing what's installed, keeps nothing for a failed memo, and runs it again", async () => {
    let fail = true;
    let runs = 0;
    const ctx = session(async (ctx) => {
      const count = await ctx.memo("count", () => {
        runs += 1;
        if (fail) throw new Error("The store is down.");
        return 3;
      });
      return countTool(count);
    });

    const error = await beforeCall(ctx).catch((caught: unknown) => caught);
    expect(isReactionFailedError(error)).toBe(true);
    expect(slotsOf(ctx, "tool")).toEqual([]);
    fail = false;
    await beforeCall(ctx);

    expect(runs).toBe(2);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 3."]);
  });

  it("keeps the memos that ran when the definition fails after them", async () => {
    let runs = 0;
    let fail = true;
    const ctx = session(async (ctx) => {
      await ctx.memo("count", () => (runs += 1));
      if (fail) throw new Error("The template is broken.");
      return null;
    });

    await beforeCall(ctx).catch(() => {});
    fail = false;
    await beforeCall(ctx);

    expect(runs).toBe(1);
  });

  it("names the file for the same key twice, and the path and type of a result that isn't JSON", async () => {
    const twice = session(async (ctx) => {
      await ctx.memo("tables", () => 1);
      await ctx.memo("tables", () => 2);
      return null;
    });
    await expect(beforeCall(twice)).rejects.toThrow(
      /"tools\/count\.ts" called ctx\.memo twice with the same key/,
    );

    const dated = session(async (ctx) => {
      await ctx.memo("accounts", () => ({ accounts: [{}, {}, { createdAt: new Date(0) }] }));
      return null;
    });
    await expect(beforeCall(dated)).rejects.toThrow("Date at $.accounts[2].createdAt");
  });

  it("caps a key at 64 KB, and a result at 1 MB, in UTF-8 bytes", async () => {
    const wideKey = session(async (ctx) => {
      await ctx.memo("é".repeat(33 * 1024), () => null);
      return null;
    });
    await expect(beforeCall(wideKey)).rejects.toThrow("a key is at most 64 KB");

    const wideResult = session(async (ctx) => {
      await ctx.memo("rows", () => "é".repeat(513 * 1024));
      return null;
    });
    await expect(beforeCall(wideResult)).rejects.toThrow("a memo result is at most 1 MB");
  });

  it("refuses an undefined field in a key, which would share the memo of a key without it", async () => {
    const results: unknown[] = [];
    const tenants = session(async (ctx) => {
      results.push(await ctx.memo({ tenantId: null }, () => ({ name: "none", region: undefined })));
      results.push(await ctx.memo({}, () => "absent"));
      return null;
    });
    await beforeCall(tenants);
    expect(results).toEqual([{ name: "none" }, "absent"]);

    const unset = session(async (ctx) => {
      await ctx.memo({ tenantId: undefined }, () => 1);
      return null;
    });
    await expect(beforeCall(unset)).rejects.toThrow(
      "has undefined at $.tenantId, which would share a memo with a key that leaves it out. Pass null",
    );
  });

  it("caps one scope's stored memo map, digest keys included, at 4 MB across failed evaluations", async () => {
    // Four results just under a quarter of the cap fit by value alone; their keys push the map over.
    const row = "x".repeat(MEMOS_CAP / 4 - 14);
    const perRow = session(async (ctx) => {
      for (let index = 0; index < 4; index += 1) await ctx.memo(["row", index], () => row);
      return null;
    });
    await expect(beforeCall(perRow)).rejects.toThrow("one definition or hook keeps at most 4 MB");

    let attempt = 0;
    const failing = session(async (ctx) => {
      attempt += 1;
      for (let index = 0; index < 2; index += 1) {
        await ctx.memo(["attempt", attempt, index], () => row);
      }
      throw new Error("The template is broken.");
    });
    for (let tries = 0; tries < 2; tries += 1) await beforeCall(failing).catch(() => {});
    const kept = Object.values(readReactionsState(failing).memos ?? {});
    expect(kept).toHaveLength(1);
    expect(Object.keys(kept[0] ?? {})).toHaveLength(2);
    expect(memoBytes(kept[0] ?? {})).toBeLessThanOrEqual(MEMOS_CAP);
  });

  it("allows concurrent memo callbacks to await and reuses both observations", async () => {
    let calls = 0;
    const ctx = session(async (ctx) => {
      const results = await Promise.all(
        ["first", "second"].map((key) =>
          ctx.memo(key, async () => {
            await Promise.resolve();
            calls += 1;
            return key;
          }),
        ),
      );
      return defineTool({ description: results.join(","), inputSchema: {}, execute: () => null });
    });
    await beforeCall(ctx);
    await beforeCall(ctx);
    expect(calls).toBe(2);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["first,second"]);
  });

  it("refuses a memo inside a memo", async () => {
    const ctx = session(async (ctx) => {
      await ctx.memo("outer", async () => {
        await Promise.resolve();
        return ctx.memo("inner", () => 1);
      });
      return null;
    });
    await expect(beforeCall(ctx)).rejects.toThrow("Memos don't nest");
  });

  it("in development, reports a value that changes with its memos fixed", async () => {
    process.env.EVE_DEV = "1";
    const ctx = session(() =>
      defineTool({
        description: `Lucky ${Math.random()}.`,
        execute: async () => null,
        inputSchema: {},
      }),
    );
    const logs = captureLogRecords();
    await beforeCall(ctx);
    expect(logs.records.map(({ message }) => message).join("\n")).toContain(
      "returned something different when evaluated again with the same memos",
    );
  });

  it("adds a user instruction when its content changes, and again after a null", async () => {
    let brief: string | null = "Today's brief.";
    const ctx = session(
      noTools,
      [],
      [() => (brief === null ? null : defineInstructions({ content: brief, role: "user" }))],
    );
    const taken = async () => {
      await beforeCall(ctx);
      return takeUserInstructionMessages(ctx).map((message) => message.content);
    };

    expect(await taken()).toHaveLength(1);
    // The same content, evaluated again, adds nothing.
    expect(await taken()).toEqual([]);
    brief = "Tomorrow's brief.";
    expect(await taken()).toHaveLength(1);
    brief = null;
    expect(await taken()).toEqual([]);
    brief = "Tomorrow's brief.";
    expect(await taken()).toHaveLength(1);
  });
});

describe("runReactions", () => {
  const hook = (
    slug: string,
    events: Record<string, (event: never, ctx: HookContext) => unknown>,
  ) => ({ events, slug });

  it("cancels the running turn once, and waits for a commit that can", async () => {
    const ctx = session(noTools, [hook("gate", { "*": (_event, ctx) => ctx.cancel("Stop.") })]);
    turnRunning(ctx);
    const cancels: unknown[] = [];
    const cancelTurn = (cancel: unknown) => cancels.push(cancel);

    await commit(ctx, { written: written(1) });
    expect(cancels).toEqual([]);
    await commit(ctx, { cancelTurn, written: written(2) });
    await commit(ctx, { cancelTurn, written: written(3) });

    expect(cancels).toEqual([{ hook: "hooks/gate.ts", reason: "Stop." }]);
  });

  it("does nothing for a cancel between turns", async () => {
    const ctx = session(noTools, [hook("gate", { "*": (_event, ctx) => ctx.cancel() })]);
    const cancels: unknown[] = [];
    const cancelTurn = (cancel: unknown) => cancels.push(cancel);
    await commit(ctx, {
      cancelTurn,
      cancelBeforeTurn: cancelTurn,
      written: written(1, "session.started"),
    });
    expect(cancels).toEqual([]);
    expect(readReactionsState(ctx).intents ?? []).toEqual([]);
  });

  it("keeps a compact request made between turns for the next model call, once", async () => {
    const ctx = session(noTools, [hook("trim", { "*": (_event, ctx) => ctx.compact() })]);
    await commit(ctx, { written: written(1, "session.started") });
    await commit(ctx, { written: written(2, "session.started") });

    expect((readReactionsState(ctx).intents ?? []).map(({ type }) => type)).toEqual(["compact"]);
    expect(takeCompactRequest(ctx)).toEqual({ hook: expect.any(String) });
    expect(takeCompactRequest(ctx)).toBeUndefined();
  });

  it("lets a hook read the latest call's input tokens and ask for a compaction", async () => {
    const ctx = session(noTools, [
      hook("trim", {
        "*": (_event, ctx) => {
          if ((ctx.view.context.inputTokens ?? 0) > 60_000) ctx.compact();
        },
      }),
    ]);
    const small = written(1, "session.started");
    await commit(ctx, { written: small });
    expect(takeCompactRequest(ctx)).toBeUndefined();

    const view = { ...initialSessionProjection().view, lastInputTokens: 61_000 };
    await commit(ctx, { written: written(2, "session.started", {}, false, view) });
    expect(takeCompactRequest(ctx)).toEqual({ hook: expect.any(String) });
  });

  it("lets a hook compare the input tokens with the compaction limit", async () => {
    const seen: unknown[] = [];
    const ctx = session(noTools, [
      hook("limit", {
        "*": (_event, ctx) => {
          seen.push(ctx.view.context.limit);
        },
      }),
    ]);
    ctx.set(StaticModelReferenceKey, { id: "m", contextWindowTokens: 100_000 });
    await commit(ctx, { written: written(1, "session.started") });
    expect(seen).toEqual([90_000]);
  });

  it("keeps a compact request made during a turn, and a cancel does not take it", async () => {
    const ctx = session(noTools, [
      hook("trim", {
        "*": (_event, ctx) => {
          ctx.compact();
          ctx.cancel("Stop.");
        },
      }),
    ]);
    turnRunning(ctx);
    const cancels: unknown[] = [];
    await commit(ctx, { written: written(1) });
    await commit(ctx, { cancelTurn: (cancel) => cancels.push(cancel), written: written(2) });

    expect(cancels).toHaveLength(1);
    expect(takeCompactRequest(ctx)).toEqual({ hook: expect.any(String) });
  });

  it("throws for a command after the handler settled", async () => {
    let later: HookContext | undefined;
    const ctx = session(noTools, [
      hook("late", {
        "turn.started": (_event, ctx) => {
          later = ctx;
        },
      }),
    ]);
    await commit(ctx, { written: written(1) });

    expect(() => later!.cancel()).toThrow("after its handler settled");
    await expect(later!.memo("late", () => null)).rejects.toThrow("after its evaluation settled");
  });

  it("fails the running turn for a handler that throws", async () => {
    const ctx = session(noTools, [
      hook("broken", {
        "turn.started": () => {
          throw new Error("The audit log is down.");
        },
      }),
    ]);
    turnRunning(ctx);

    await commit(ctx, { written: written(1) });

    expect(takeTurnFailure(ctx)).toContain('Hook "hooks/broken.ts" failed: The audit log is down.');
  });

  it("fails the running turn instead of cancelling it for a handler that cancels, then throws", async () => {
    const ctx = session(noTools, [
      hook("broken", {
        "turn.started": (_event, ctx) => {
          ctx.cancel("Stop.");
          throw new Error("The audit log is down.");
        },
      }),
    ]);
    turnRunning(ctx);
    const cancels: unknown[] = [];

    await commit(ctx, { cancelTurn: (cancel) => cancels.push(cancel), written: written(1) });

    expect(cancels).toEqual([]);
    expect(takeTurnFailure(ctx)).toContain('Hook "hooks/broken.ts" failed: The audit log is down.');
  });

  it("runs only handlers that name streamed progress for a commit of it", async () => {
    const heard: string[] = [];
    const ctx = session(noTools, [
      hook("all", { "*": () => heard.push("*") }),
      hook("deltas", { "content.delta": () => heard.push("content.delta") }),
    ]);

    await commit(ctx, { written: written(1, "content.delta", {}, true) });
    await commit(ctx, { written: written(2) });

    expect(heard).toEqual(["content.delta", "*"]);
  });

  it("reads an authored channel by its channel kind, and an opaque view", async () => {
    const seen: unknown[] = [];
    const ctx = session(noTools, [
      hook("notify", {
        "turn.started": (_event, ctx) =>
          seen.push(ctx.channel.kind, publicSession(ctx.view).status),
      }),
    ]);
    ctx.set(ChannelKey, { kind: "http" } as never);
    ctx.set(ChannelInstrumentationKey, { kind: "channel:support", metadata: {} });

    await commit(ctx, { written: written(1) });

    expect(seen).toEqual(["channel:support", "new"]);
  });

  it("gives each handler call the fact's position as its occurrence", async () => {
    const keys: string[] = [];
    const ctx = session(noTools, [
      hook("audit", {
        "turn.started": (_event, ctx) => keys.push(ctx.occurrence.idempotencyKey),
      }),
    ]);

    await commit(ctx, { written: written(1) });
    await commit(ctx, { written: written(2) });

    expect(keys).toEqual([
      expect.stringMatching(/:hook:audit:1\.0:turn\.started$/),
      expect.stringMatching(/:hook:audit:2\.0:turn\.started$/),
    ]);
  });
});
