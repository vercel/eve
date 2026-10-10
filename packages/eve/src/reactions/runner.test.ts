import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineTool } from "#tools/definition.js";
import { dynamicTools } from "./kinds/tool.js";
import { restoreReactions, runReactions, slotsOf } from "./runner.js";
import { forgetSessionLive, readReactionsState } from "./state.js";

const user = (content: string): ModelMessage => ({ content, role: "user" });

function written(line: number, type = "turn.started") {
  return [
    {
      event: { data: {}, meta: { position: { index: 0, line } }, type },
      position: { index: 0, line },
      progress: false,
      view: {},
    },
  ] as never;
}

/** A session whose bundle declares one dynamic tool resolver. */
function session(resolver: {
  readonly select?: (view: never, ctx: never) => unknown;
  readonly resolve: (selected: never, ctx: never) => unknown;
}) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(BundleKey, {
    resolvedAgent: {
      dynamicInstructionsResolvers: [],
      dynamicSkillResolvers: [],
      dynamicToolResolvers: [
        { logicalPath: "tools/count.ts", slug: "count", sourceId: "tools/count.ts", ...resolver },
      ],
      hooks: [],
      memories: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {},
  } as never);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

const counted = (selections: unknown[]) => ({
  resolve: (selected: never) => {
    selections.push(selected);
    return defineTool({
      description: `Count ${String(selected)}.`,
      execute: async () => selected,
      inputSchema: {},
    });
  },
  select: ((view: { readonly messages: readonly ModelMessage[] }) => view.messages.length) as never,
});

describe("runReactions", () => {
  it("resolves only when the selection changes", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));

    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });
    await runReactions(ctx, { conversation: [user("a"), user("b")], written: written(3) });

    expect(selections).toEqual([1, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
    expect(readReactionsState(ctx).latest).toMatchObject({ "*": 3, "turn.started": 3 });
  });

  it("skips a reaction that reads the conversation where the step has none, keeping its slot", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));

    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await runReactions(ctx, { written: written(2, "task.ended") });

    expect(selections).toEqual([1]);
    expect(slotsOf(ctx, "tool")).toHaveLength(1);
  });

  it("rebuilds code in a fresh process from the recorded selection", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));
    await runReactions(ctx, { conversation: [user("a"), user("b")], written: written(1) });

    forgetSessionLive(ctx.get(SessionIdKey)!);
    expect(dynamicTools(ctx)).toEqual([]);
    await restoreReactions(ctx);

    expect(selections).toEqual([2, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
  });

  it("withdraws the slot of a resolve that throws, retrying when the selection changes", async () => {
    let fail = false;
    let calls = 0;
    const ctx = session({
      resolve: (() => {
        calls += 1;
        if (fail) throw new Error("listing failed");
        return defineTool({ description: "Listed.", execute: async () => null, inputSchema: {} });
      }) as never,
      select: ((view: { readonly latest: Record<string, number> }) =>
        view.latest["turn.started"] ?? null) as never,
    });

    await runReactions(ctx, { written: written(1) });
    expect(slotsOf(ctx, "tool")).toHaveLength(1);
    fail = true;
    await runReactions(ctx, { written: written(2) });

    expect(slotsOf(ctx, "tool").map(({ slot }) => slot.value)).toEqual([null]);
    expect(slotsOf(ctx, "tool").every(({ live }) => live === undefined)).toBe(true);
    // The failed selection waits for a new one rather than retrying on every commit.
    await runReactions(ctx, { written: written(3, "step.started") });
    expect(calls).toBe(2);
    await runReactions(ctx, { written: written(4) });
    expect(calls).toBe(3);
  });

  it("resolves again under a new runtime revision", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));
    await restoreReactions(ctx, { revision: "r1" });
    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await restoreReactions(ctx, { revision: "r2" });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });

    expect(selections).toEqual([1, 1]);
  });
});
