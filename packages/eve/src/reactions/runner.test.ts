import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import {
  enterSessionProjection,
  enterSessionProjectionAt,
} from "#harness/session-machine/current.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineState } from "#public/definitions/state.js";
import { defineTool } from "#tools/definition.js";
import { dynamicTools } from "./kinds/tool.js";
import { restoreReactions, runReactions, slotsOf } from "./runner.js";
import { cancel, compact } from "#public/definitions/hook.js";
import { hasPendingCompaction } from "./kinds/hook.js";
import { forgetSessionLive, readReactionsState, writeReactionsState } from "./state.js";

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
    readonly resolve: (selected: never, ctx: never) => unknown;
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

/** Runs reactions inside the session's context, which hooks read. */
async function inSession(ctx: ContextContainer, input: Parameters<typeof runReactions>[1]) {
  if (ctx.get(SessionKey) === undefined) {
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: ctx.get(SessionIdKey),
    } as never);
  }
  await contextStorage.run(ctx, async () => await runReactions(ctx, input));
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

  it("records the new selection of a code slot even when its declaration is unchanged", async () => {
    // Both scopes declare the same tool; only the code that closes over the scope differs.
    const built: string[] = [];
    const ctx = session({
      resolve: ((scope: string) => {
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
    await runReactions(ctx, { conversation: [user("tenant-a")], written: written(1) });
    await runReactions(ctx, { conversation: [user("tenant-b")], written: written(2) });
    expect(slotsOf(ctx, "tool")[0]?.slot.selection).toBe("tenant-b");

    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx);

    // The rebuild in a fresh process binds the tool to the latest tenant, not the first.
    expect(built).toEqual(["tenant-a", "tenant-b", "tenant-b"]);
  });

  it("fails calls to a tool whose rebuilt declaration differs from the one offered", async () => {
    let description = "Offered.";
    const ctx = session({
      resolve: (() =>
        defineTool({ description, execute: async () => "ran", inputSchema: {} })) as never,
    });
    await runReactions(ctx, { written: written(1) });

    description = "Changed.";
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx);

    const [tool] = dynamicTools(ctx);
    expect(tool?.description).toBe("Offered.");
    await expect(tool!.execute!({}, {} as never)).rejects.toThrow(
      'Tool "count" changed since it was offered.',
    );
  });

  it("keeps the model out of the view of reactions that run before it", async () => {
    const seen: unknown[] = [];
    const ctx = session(
      {
        resolve: (() => null) as never,
        select: ((view: { readonly model: unknown }) => {
          seen.push(view.model);
          return null;
        }) as never,
      },
      [
        {
          events: {},
          logicalPath: "hooks/modal.ts",
          resolve: () => null,
          select: (view: { readonly model: unknown }) => view.model,
          slug: "modal",
        },
      ],
    );
    await runReactions(ctx, { written: written(1) });

    // The tool runs after the model and reads it; the hook's select threw, so its slot is empty.
    expect(seen).toEqual([null]);
    expect(slotsOf(ctx, "hook").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining("view.model isn't available to a hook reaction"),
    ]);
  });

  it("compacts once per entry, and records it rather than reading it from the view", async () => {
    let imports = 1;
    const ctx = session({ resolve: (() => null) as never, select: (() => null) as never }, [
      {
        events: {},
        logicalPath: "hooks/imports.ts",
        resolve: (count: number) => ({ [`import-${count}`]: compact() }),
        select: () => imports,
        slug: "imports",
      },
    ]);
    await inSession(ctx, { written: written(1) });
    expect(hasPendingCompaction(ctx)).toBe(true);

    await inSession(ctx, { written: written(2, "context.started", { kind: "compaction" }) });
    expect(hasPendingCompaction(ctx)).toBe(false);
    // Losing what the view knew about that compaction doesn't make the intent pending again.
    writeReactionsState(ctx, { ...readReactionsState(ctx), latest: {} });
    await inSession(ctx, { written: written(3) });
    expect(hasPendingCompaction(ctx)).toBe(false);

    imports = 2;
    await inSession(ctx, { written: written(4) });
    expect(hasPendingCompaction(ctx)).toBe(true);
  });

  it("cancels the running turn once, and waits for a commit that can", async () => {
    const ctx = session({ resolve: (() => null) as never, select: (() => null) as never }, [
      {
        events: {},
        logicalPath: "hooks/stop.ts",
        resolve: () => cancel("Asked to stop."),
        select: () => null,
        slug: "stop",
      },
    ]);
    // A turn is running.
    enterSessionProjectionAt(ctx, { ...initialSessionProjection(), activeTurnId: "turn-1" });
    const stopped: unknown[] = [];

    await inSession(ctx, { written: written(1) });
    expect(stopped).toEqual([]);
    const cancelTurn = (cancel: unknown) => void stopped.push(cancel);
    await inSession(ctx, { cancelTurn, written: written(2) });
    await inSession(ctx, { cancelTurn, written: written(3) });

    expect(stopped).toEqual([{ hook: "hooks/stop.ts", reason: "Asked to stop." }]);
  });

  it("runs resolve outside the session's context, so it reads only its selection", async () => {
    const counter = defineState("runner-test.counter", () => 7);
    const read = session({
      resolve: (() => counter.get()) as never,
      select: (() => null) as never,
    });
    const selected = session({
      resolve: ((count: number) =>
        defineTool({
          description: `Count ${count}.`,
          execute: async () => count,
          inputSchema: {},
        })) as never,
      select: (() => counter.get()) as never,
    });
    await inSession(read, { written: written(1) });
    await inSession(selected, { written: written(1) });

    expect(slotsOf(read, "tool").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining(
        '"tools/count.ts" read session state in resolve, which reads only its selection',
      ),
    ]);
    expect(dynamicTools(selected).map((tool) => tool.description)).toEqual(["Count 7."]);
  });

  it("runs only hooks for a commit of streamed progress", async () => {
    let selects = 0;
    const ctx = session({
      resolve: (() => null) as never,
      select: (() => {
        selects += 1;
        return null;
      }) as never,
    });
    const [record] = written(1, "content.delta") as unknown as readonly object[];
    const delta = [{ ...record, progress: true }] as never;
    await runReactions(ctx, { written: delta });
    expect(selects).toBe(0);

    await runReactions(ctx, { written: written(2) });
    expect(selects).toBe(1);
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

  it("doesn't resolve again under a new revision what a fresh process rebuilt under it", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));
    await restoreReactions(ctx, { revision: "r1" });
    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx, { revision: "r2" });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });

    // Once to choose, once to rebuild under r2, and not again after r2's first commit.
    expect(selections).toEqual([1, 1]);
    expect(slotsOf(ctx, "tool")[0]?.slot.revision).toBe("r2");
  });

  it("keeps a data slot under a new runtime revision until its selection changes", async () => {
    const resolved: unknown[] = [];
    const ctx = session(
      { resolve: (() => null) as never, select: (() => null) as never },
      [],
      [
        {
          logicalPath: "instructions/policy.ts",
          resolve: (selected: unknown) => {
            resolved.push(selected);
            return defineInstructions({ markdown: `Policy ${String(selected)}.` });
          },
          select: (view: { readonly messages: readonly ModelMessage[] }) => view.messages.length,
          slug: "policy",
          sourceId: "instructions/policy.ts",
        },
      ],
    );
    await restoreReactions(ctx, { revision: "r1" });
    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await restoreReactions(ctx, { revision: "r2" });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });
    expect(resolved).toEqual([1]);

    await runReactions(ctx, { conversation: [user("a"), user("b")], written: written(3) });
    expect(resolved).toEqual([1, 2]);
  });
});
