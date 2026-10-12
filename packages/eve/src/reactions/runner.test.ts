import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import {
  enterSessionProjection,
  enterSessionProjectionAt,
} from "#harness/session-machine/current.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { foldLine } from "#protocol/session-projection/fold.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineState } from "#public/definitions/state.js";
import { defineTool } from "#tools/definition.js";
import { takeUserInstructionMessages } from "./kinds/instructions.js";
import { dynamicTools } from "./kinds/tool.js";
import { evaluateValues, restoreReactions, runReactions } from "./runner.js";
import { slotsOf } from "./state.js";
import { cancel, compact } from "#public/definitions/hook.js";
import { hasPendingCompaction, takeTurnFailure } from "./intents.js";
import { forgetSessionLive, readReactionsState } from "./state.js";

const user = (content: string): ModelMessage => ({ content, role: "user" });

function written(line: number, type = "turn.started", data: object = {}) {
  return [
    {
      event: { data, meta: { position: { index: 0, line } }, type },
      position: { index: 0, line },
      progress: false,
      view: {},
    },
  ] as never;
}

/** A session whose bundle declares one dynamic tool resolver, and optionally hooks. */
function session(
  resolver: {
    readonly select?: (view: never, ctx: never) => unknown;
    readonly record?: (selected: never, ctx: never) => unknown;
    readonly render?: (input: never) => unknown;
  },
  hooks: readonly object[] = [],
  instructions: readonly object[] = [],
) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(BundleKey, {
    resolvedAgent: {
      dynamicInstructionsResolvers: instructions,
      dynamicSkillResolvers: [],
      dynamicToolResolvers: [
        { logicalPath: "tools/count.ts", slug: "count", sourceId: "tools/count.ts", ...resolver },
      ],
      hooks,
      memories: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {},
  } as never);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

/** Runs a commit's reactions inside the session's context, which hooks read. */
async function commit(ctx: ContextContainer, input: Parameters<typeof runReactions>[1]) {
  if (ctx.get(SessionKey) === undefined) {
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: ctx.get(SessionIdKey),
    } as never);
  }
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

/** A tool whose `record` logs each selection it records, and whose `render` each render. */
const counted = (selections: unknown[], builds: unknown[] = []) => ({
  render: ((count: unknown) => {
    builds.push(count);
    return countTool(count);
  }) as never,
  record: ((selected: never) => {
    selections.push(selected);
    return selected;
  }) as never,
  select: ((view: { readonly messages: readonly ModelMessage[] }) => view.messages.length) as never,
});

const noTools = { render: (() => null) as never, select: (() => null) as never };

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
});

describe("evaluateValues", () => {
  it("evaluates a value before a model call only when its selection changes", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));

    await beforeCall(ctx, [user("a")]);
    await beforeCall(ctx, [user("a")]);
    await beforeCall(ctx, [user("a"), user("b")]);

    expect(selections).toEqual([1, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
  });

  it("leaves values alone after commits, which only hooks react to", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));

    await commit(ctx, { conversation: [user("a")], written: written(1) });

    expect(selections).toEqual([]);
    expect(readReactionsState(ctx).latest).toMatchObject({ "*": 1, "turn.started": 1 });
  });

  it("renders code in a fresh process from what the slot recorded, without recording again", async () => {
    const selections: unknown[] = [];
    const builds: unknown[] = [];
    const ctx = session(counted(selections, builds));
    await beforeCall(ctx, [user("a"), user("b")]);

    forgetSessionLive(ctx.get(SessionIdKey)!);
    expect(dynamicTools(ctx)).toEqual([]);
    await restoreReactions(ctx);

    expect(selections).toEqual([2]);
    expect(builds).toEqual([2, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
  });

  it("renders from the latest record even when what the model is offered is unchanged", async () => {
    // Both scopes offer the same tool; only the code that closes over the scope differs.
    const built: string[] = [];
    const ctx = session({
      render: ((scope: string) => {
        built.push(scope);
        return defineTool({
          description: "Forget a memory.",
          execute: async () => scope,
          inputSchema: {},
        });
      }) as never,
      select: ((view: { readonly messages: readonly ModelMessage[] }) =>
        String(view.messages.at(-1)?.content)) as never,
    });
    await beforeCall(ctx, [user("tenant-a")]);
    await beforeCall(ctx, [user("tenant-b")]);
    expect(slotsOf(ctx, "tool")[0]?.slot.input).toBe("tenant-b");

    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx);

    expect(built).toEqual(["tenant-a", "tenant-b", "tenant-b"]);
  });

  it("evaluates again before the next model call when a fresh render doesn't match", async () => {
    let description = "Offered.";
    let records = 0;
    const ctx = session({
      record: (() => {
        records += 1;
        return null;
      }) as never,
      render: (() =>
        defineTool({ description, execute: async () => "ran", inputSchema: {} })) as never,
      select: (() => null) as never,
    });
    await beforeCall(ctx);

    description = "Changed.";
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx);

    // The mismatched render offers nothing, rather than another tool under the same record.
    expect(dynamicTools(ctx)).toEqual([]);
    expect(slotsOf(ctx, "tool")[0]?.slot.invalid).toBe(true);
    await beforeCall(ctx);
    expect(records).toBe(2);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Changed."]);
  });

  it("fails without recording, and evaluates again at the next model call", async () => {
    let fail = true;
    let records = 0;
    const ctx = session({
      record: (() => {
        records += 1;
        if (fail) throw new Error("listing failed");
        return "listed";
      }) as never,
      render: (() =>
        defineTool({
          description: "Listed.",
          execute: async () => null,
          inputSchema: {},
        })) as never,
      select: (() => null) as never,
    });

    await expect(beforeCall(ctx)).rejects.toThrow("listing failed");
    expect(slotsOf(ctx, "tool")).toEqual([]);
    // The selection is the same, `once`, but nothing was recorded for it.
    fail = false;
    await beforeCall(ctx);
    expect(records).toBe(2);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Listed."]);
  });

  it("requires JSON from a record that render renders from", async () => {
    const ctx = session({
      render: ((tool: never) => tool) as never,
      record: (() => countTool(1)) as never,
      select: (() => null) as never,
    });
    await expect(beforeCall(ctx)).rejects.toThrow(
      'The record of "tools/count.ts" must return JSON',
    );
  });

  it("rejects a render that returns a promise, since render can't do I/O", async () => {
    const ctx = session({
      render: (async () => countTool(1)) as never,
      select: (() => null) as never,
    });
    await expect(beforeCall(ctx)).rejects.toThrow(
      'The render of "tools/count.ts" returned a promise',
    );
  });

  it("caps a selection at 64 KB, and a record at 1 MB, in UTF-8 bytes", async () => {
    const selected = session({
      render: (() => null) as never,
      select: (() => "x".repeat(70_000)) as never,
    });
    await expect(beforeCall(selected)).rejects.toThrow("a selection is at most 64 KB");

    // The caps count UTF-8 bytes: 30,000 three-byte characters are 90 KB.
    const wide = session({
      render: (() => null) as never,
      select: (() => "€".repeat(30_000)) as never,
    });
    await expect(beforeCall(wide)).rejects.toThrow("a selection is at most 64 KB");

    const recorded = session({
      record: (() => "x".repeat(1_100_000)) as never,
      render: (() => null) as never,
      select: (() => null) as never,
    });
    await expect(beforeCall(recorded)).rejects.toThrow("a record is at most 1 MB");
  });

  it("runs record and render outside the session's context, so they read only the selection", async () => {
    const counter = defineState("runner-test.counter", () => 7);
    const read = session({
      record: (() => counter.get()) as never,
      render: (() => null) as never,
      select: (() => null) as never,
    });
    const built = session({
      render: (() => counter.get()) as never,
      select: (() => null) as never,
    });
    const selected = session({
      render: ((count: number) => countTool(count)) as never,
      select: (() => counter.get()) as never,
    });
    for (const ctx of [read, built]) {
      await expect(beforeCall(ctx)).rejects.toThrow(
        '"tools/count.ts" read session state in record or render',
      );
    }
    await beforeCall(selected);
    expect(dynamicTools(selected).map((tool) => tool.description)).toEqual(["Count 7."]);
  });

  it("evaluates code and data again under a new deployment, rendering nothing of the old one's", async () => {
    const selections: unknown[] = [];
    const builds: unknown[] = [];
    const policies: unknown[] = [];
    const ctx = session(
      counted(selections, builds),
      [],
      [
        {
          logicalPath: "instructions/policy.ts",
          record: (selected: unknown) => {
            policies.push(selected);
            return defineInstructions({ markdown: "Policy." });
          },
          select: () => null,
          slug: "policy",
          sourceId: "instructions/policy.ts",
        },
      ],
    );
    await restoreReactions(ctx, { revision: "r1" });
    await beforeCall(ctx, [user("a")]);
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx, { revision: "r2" });
    // r2's render doesn't run on r1's record; the model call evaluates under r2 instead.
    expect(dynamicTools(ctx)).toEqual([]);
    await beforeCall(ctx, [user("a")]);

    expect(selections).toEqual([1, 1]);
    expect(builds).toEqual([1, 1]);
    expect(policies).toEqual([null, null]);
    expect(slotsOf(ctx, "tool")[0]?.slot.revision).toBe("r2");
  });

  it("drops the slot of a reaction a new deployment removed", async () => {
    const policy = {
      logicalPath: "instructions/policy.ts",
      record: () => defineInstructions({ markdown: "Policy." }),
      select: () => null,
      slug: "policy",
      sourceId: "instructions/policy.ts",
    };
    const ctx = session(counted([]), [], [policy]);
    await beforeCall(ctx, [user("a")]);
    expect(slotsOf(ctx, "instructions")).toHaveLength(1);

    // The next deployment deleted the instruction file.
    const bundle = ctx.get(BundleKey) as { resolvedAgent: object };
    ctx.set(BundleKey, {
      ...bundle,
      resolvedAgent: { ...bundle.resolvedAgent, dynamicInstructionsResolvers: [] },
    } as never);
    await restoreReactions(ctx, { revision: "r2" });

    expect(slotsOf(ctx, "instructions")).toEqual([]);
    expect(slotsOf(ctx, "tool")).toHaveLength(1);
  });

  it("in development, fails a render that isn't deterministic", async () => {
    process.env.EVE_DEV = "1";
    const ctx = session({
      render: (() =>
        defineTool({
          description: `Lucky ${Math.random()}.`,
          execute: async () => null,
          inputSchema: {},
        })) as never,
      select: (() => null) as never,
    });
    await expect(beforeCall(ctx)).rejects.toThrow("rendered differently from the same record");
  });

  it("adds a user instruction once per occurrence, even when its text repeats", async () => {
    let turn = 1;
    const ctx = session(
      noTools,
      [],
      [
        {
          logicalPath: "instructions/brief.ts",
          render: () => defineInstructions({ content: "Today's brief.", role: "user" }),
          select: () => turn,
          slug: "brief",
          sourceId: "instructions/brief.ts",
        },
      ],
    );
    const taken = () => takeUserInstructionMessages(ctx).map((message) => message.content);

    await beforeCall(ctx);
    expect(taken()).toHaveLength(1);
    // The same occurrence, evaluated or taken again, adds nothing.
    await beforeCall(ctx);
    expect(taken()).toEqual([]);
    turn = 2;
    await beforeCall(ctx);
    expect(taken()).toHaveLength(1);
  });
});

describe("runReactions", () => {
  it("keeps the model out of the view of hooks, which fail the running turn", async () => {
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/modal.ts",
        run: () => null,
        select: (view: { readonly model: unknown }) => view.model,
        slug: "modal",
      },
    ]);
    turnRunning(ctx);
    await commit(ctx, { written: written(1) });

    expect(takeTurnFailure(ctx)).toContain("view.model isn't available to a hook reaction");
  });

  it("compacts once per occurrence, without naming it", async () => {
    let imports = 1;
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/imports.ts",
        run: () => compact(),
        select: () => imports,
        slug: "imports",
      },
    ]);
    await commit(ctx, { written: written(1) });
    expect(hasPendingCompaction(ctx)).toBe(true);

    await commit(ctx, { written: written(2, "context.started", { kind: "compaction" }) });
    expect(hasPendingCompaction(ctx)).toBe(false);
    // The same selection is the same occurrence, which already acted.
    await commit(ctx, { written: written(3) });
    expect(hasPendingCompaction(ctx)).toBe(false);

    imports = 2;
    await commit(ctx, { written: written(4) });
    expect(hasPendingCompaction(ctx)).toBe(true);
  });

  it("gives every occurrence its own key, even when a selection comes back", async () => {
    const occurrences: string[] = [];
    let idle = false;
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/notify.ts",
        run: (
          _selected: unknown,
          hookContext: { readonly occurrence: { readonly id: string } },
        ) => {
          occurrences.push(hookContext.occurrence.id);
          return null;
        },
        select: () => idle,
        slug: "notify",
      },
    ]);
    for (const [line, value] of [false, true, false, true].entries()) {
      idle = value;
      await commit(ctx, { written: written(line + 1) });
    }

    expect(occurrences).toHaveLength(4);
    expect(new Set(occurrences).size).toBe(4);
    expect(occurrences[0]).toContain(":notify:1:");
  });

  it("cancels the running turn once, and waits for a commit that can", async () => {
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/stop.ts",
        run: () => cancel("Asked to stop."),
        select: () => null,
        slug: "stop",
      },
    ]);
    turnRunning(ctx);
    const stopped: unknown[] = [];

    await commit(ctx, { written: written(1) });
    expect(stopped).toEqual([]);
    const cancelTurn = (cancel: unknown) => void stopped.push(cancel);
    await commit(ctx, { cancelTurn, written: written(2) });
    await commit(ctx, { cancelTurn, written: written(3) });

    expect(stopped).toEqual([{ hook: "hooks/stop.ts", reason: "Asked to stop." }]);
  });

  it("fails the running turn for a hook that throws, without running its occurrence again", async () => {
    let runs = 0;
    const throwing = {
      events: {},
      logicalPath: "hooks/check.ts",
      run: () => {
        runs += 1;
        throw new Error("credentials unavailable");
      },
      select: () => null,
      slug: "check",
    };
    const ctx = session(noTools, [throwing]);
    turnRunning(ctx);
    await commit(ctx, { written: written(1) });
    await commit(ctx, { written: written(2) });

    expect(runs).toBe(1);
    expect(takeTurnFailure(ctx)).toBe('Hook "hooks/check.ts" failed: credentials unavailable');
    expect(takeTurnFailure(ctx)).toBeUndefined();

    // Between turns, there's no turn to fail.
    const between = session(noTools, [throwing]);
    await commit(between, { written: written(1) });
    expect(readReactionsState(between).intents ?? []).toEqual([]);
  });

  it("fails the running turn for an events handler that throws", async () => {
    const ctx = session(noTools, [
      {
        events: {
          "turn.started": () => {
            throw new Error("audit unavailable");
          },
        },
        logicalPath: "hooks/audit.ts",
        slug: "audit",
      },
    ]);
    turnRunning(ctx);
    await commit(ctx, { written: written(1) });

    expect(takeTurnFailure(ctx)).toBe('Hook "hooks/audit.ts" failed: audit unavailable');
  });

  it("runs only hooks that handle streamed progress for a commit of it", async () => {
    let selects = 0;
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/count.ts",
        run: () => null,
        select: () => {
          selects += 1;
          return null;
        },
        slug: "count",
      },
    ]);
    const [record] = written(1, "content.delta") as readonly object[];
    await commit(ctx, { written: [{ ...record, progress: true }] as never });
    expect(selects).toBe(1);
  });
});
