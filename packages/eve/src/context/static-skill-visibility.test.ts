import { describe, expect, it } from "vitest";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  dispatchStaticSkillVisibilityEvent,
  filterVisibleStaticSkills,
  initializeStaticSkillVisibility,
  StaticSkillVisibilityKey,
} from "#context/static-skill-visibility.js";
import { createSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { defineStaticSkillVisibility } from "#public/definitions/agent.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { ResolvedStaticSkillVisibilityReference } from "#runtime/types.js";
import type { StaticSkillVisibility } from "#shared/agent-definition.js";

const STATIC_SKILL_NAMES = ["alpha", "beta", "packaged"] as const;
const RESOLVER: ResolvedStaticSkillVisibilityReference = {
  eventNames: ["session.started", "turn.started"],
  exportName: "default",
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module",
};

describe("static skill visibility lifecycle", () => {
  it("defaults to all static skills and reconciles durable inventory on replay", async () => {
    const ctx = new ContextContainer();
    initializeStaticSkillVisibility(ctx, STATIC_SKILL_NAMES);
    expect(ctx.get(StaticSkillVisibilityKey)).toEqual({
      kind: "all",
      names: [...STATIC_SKILL_NAMES],
    });

    ctx.set(StaticSkillVisibilityKey, { kind: "all", names: ["alpha", "removed"] });
    const replayedAll = await deserializeContext(serializeContext(ctx));
    initializeStaticSkillVisibility(replayedAll, ["alpha", "beta"]);
    expect(replayedAll.get(StaticSkillVisibilityKey)).toEqual({
      kind: "all",
      names: ["alpha", "beta"],
    });

    ctx.set(StaticSkillVisibilityKey, { kind: "subset", names: ["beta", "removed"] });
    const replayedSubset = await deserializeContext(serializeContext(ctx));
    initializeStaticSkillVisibility(replayedSubset, ["alpha", "beta"]);
    expect(replayedSubset.get(StaticSkillVisibilityKey)).toEqual({
      kind: "subset",
      names: ["beta"],
    });
  });

  it("supports all, subset, empty, unknown, and next-turn resolutions", async () => {
    let selection: StaticSkillVisibility = "all";
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap(
      defineStaticSkillVisibility({
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
      defineStaticSkillVisibility({
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

  it("changes the actual session prompt at a lifecycle boundary and stays cache-stable within it", async () => {
    let selection: StaticSkillVisibility = ["beta"];
    const ctx = new ContextContainer();
    initializeStaticSkillVisibility(ctx, STATIC_SKILL_NAMES);
    const moduleMap = createModuleMap(
      defineStaticSkillVisibility({
        events: {
          "session.started": () => selection,
          "turn.started": () => selection,
        },
      }),
    );
    const turnAgent = createTestTurnAgent();
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "session-1",
      skillRoot: "/home/agent/.agents/skills",
      turnAgent,
    });

    await dispatch(ctx, moduleMap, createSessionStartedEvent());
    const refreshed = refreshSessionFromTurnAgent({
      session,
      skillRoot: "/home/agent/.agents/skills",
      turnAgent: {
        ...turnAgent,
        availableSkills: filterVisibleStaticSkills(
          turnAgent.availableSkills,
          ctx.get(StaticSkillVisibilityKey),
        ),
      },
    });
    expect(refreshed.agent.system).toContain("- beta: beta skill");
    expect(refreshed.agent.system).not.toContain("- alpha: alpha skill");

    const sameTurn = refreshSessionFromTurnAgent({
      session: refreshed,
      skillRoot: "/home/agent/.agents/skills",
      turnAgent: {
        ...turnAgent,
        availableSkills: filterVisibleStaticSkills(
          turnAgent.availableSkills,
          ctx.get(StaticSkillVisibilityKey),
        ),
      },
    });
    expect(sameTurn.agent.system).toBe(refreshed.agent.system);

    selection = ["packaged"];
    await dispatch(ctx, moduleMap, createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }));
    const nextTurn = refreshSessionFromTurnAgent({
      session: refreshed,
      skillRoot: "/home/agent/.agents/skills",
      turnAgent: {
        ...turnAgent,
        availableSkills: filterVisibleStaticSkills(
          turnAgent.availableSkills,
          ctx.get(StaticSkillVisibilityKey),
        ),
      },
    });
    expect(nextTurn.agent.system).toContain("- packaged: packaged skill");
    expect(nextTurn.agent.system).not.toBe(refreshed.agent.system);
  });
});

function createTestTurnAgent(): RuntimeTurnAgent {
  return {
    availableSkills: STATIC_SKILL_NAMES.map((name) => ({
      description: `${name} skill`,
      name,
    })),
    id: "test-agent",
    instructions: ["You are a helpful assistant."],
    model: { id: "test-model" },
    tools: [],
    workspaceSpec: { rootEntries: [] },
  };
}

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
