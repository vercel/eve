import { describe, expect, it } from "vitest";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import {
  dispatchStaticSkillVisibilityEvent,
  filterVisibleStaticSkills,
  StaticSkillVisibilityKey,
} from "#context/static-skill-visibility.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import type { ResolvedStaticSkillVisibilityReference } from "#runtime/types.js";

const STATIC_SKILL_NAMES = ["alpha", "beta", "packaged"] as const;
const RESOLVER: ResolvedStaticSkillVisibilityReference = {
  eventNames: ["session.started", "turn.started"],
  exportName: "default",
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module",
};

describe("static skill visibility lifecycle", () => {
  it("supports all, subset, empty, unknown, and next-turn resolutions", async () => {
    let selection: unknown = "all";
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap(
      defineDynamic({
        events: {
          "session.started": () => selection,
          "turn.started": () => selection,
        },
      }),
    );

    await dispatch(ctx, moduleMap, createSessionStartedEvent());
    expect(ctx.get(StaticSkillVisibilityKey)).toEqual({
      kind: "all",
      names: [...STATIC_SKILL_NAMES],
    });

    selection = ["beta"];
    await dispatch(ctx, moduleMap, createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }));
    expect(ctx.get(StaticSkillVisibilityKey)).toEqual({ kind: "subset", names: ["beta"] });

    selection = [];
    await dispatch(ctx, moduleMap, createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }));
    expect(ctx.get(StaticSkillVisibilityKey)).toEqual({ kind: "subset", names: [] });

    selection = ["unknown"];
    await dispatch(ctx, moduleMap, createTurnStartedEvent({ sequence: 2, turnId: "turn_2" }));
    expect(ctx.get(StaticSkillVisibilityKey)).toEqual({ kind: "subset", names: [] });
  });

  it("fails closed when the resolver throws and preserves the state across replay", async () => {
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap(
      defineDynamic({
        events: {
          "session.started": () => {
            throw new Error("policy unavailable");
          },
        },
      }),
    );

    await dispatch(ctx, moduleMap, createSessionStartedEvent());
    expect(ctx.get(StaticSkillVisibilityKey)).toEqual({ kind: "subset", names: [] });

    const replayed = new ContextContainer();
    replayed.set(StaticSkillVisibilityKey, ctx.get(StaticSkillVisibilityKey)!);
    expect(replayed.get(StaticSkillVisibilityKey)).toEqual({ kind: "subset", names: [] });
  });

  it("filters prompt descriptions without changing packaged skill identity", () => {
    const visible = filterVisibleStaticSkills(
      STATIC_SKILL_NAMES.map((name) => ({ description: `${name} skill`, name })),
      { kind: "subset", names: ["packaged"] },
    );

    expect(visible).toEqual([{ description: "packaged skill", name: "packaged" }]);
  });
});

async function dispatch(
  ctx: ContextContainer,
  moduleMap: CompiledModuleMap,
  event: Parameters<typeof dispatchStaticSkillVisibilityEvent>[0]["event"],
): Promise<void> {
  await dispatchStaticSkillVisibilityEvent({
    ctx,
    event,
    messages: [],
    resolver: RESOLVER,
    scope: { moduleMap, nodeId: undefined },
    staticSkillNames: STATIC_SKILL_NAMES,
  });
}

function createModuleMap(resolver: unknown): CompiledModuleMap {
  return {
    nodes: {
      __root__: {
        modules: {
          [RESOLVER.sourceId]: {
            default: {
              model: "openai/gpt-5.5",
              staticSkillVisibility: resolver,
            },
          },
        },
      },
    },
  };
}
