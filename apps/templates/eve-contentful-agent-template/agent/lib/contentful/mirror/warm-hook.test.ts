import type {
  Experimental_SandboxProcess,
  Experimental_SandboxSession,
} from "ai";
import type { HookEvent } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installTestState, testState } from "../../testing/state";
import { MIRROR_PREFETCH_COMMAND } from "./prefetch";
import hook, {
  MIRROR_SQL_SKILL,
  warmOnSkillLoad,
  warmOnTurnStart,
} from "./warm-hook";

const meta = { at: "2026-10-20T00:00:00.000Z", id: "event-1" };

const started: Experimental_SandboxProcess = {
  kill: () => Promise.resolve(),
  stderr: new ReadableStream(),
  stdout: new ReadableStream(),
  wait: () => Promise.resolve({ exitCode: 0 }),
};

/* Context whose sandbox records spawned commands. */
const warmContext = () => {
  const spawn = vi.fn<Experimental_SandboxSession["spawn"]>(() =>
    Promise.resolve(started)
  );
  const getSandbox = vi.fn(() => Promise.resolve({ spawn }));
  return { ctx: { getSandbox }, getSandbox, spawn };
};

type Action = HookEvent<"actions.requested">["data"]["actions"][number];

const loadSkill = (skill: string): Action => ({
  callId: `call-${skill}`,
  input: { skill },
  kind: "load-skill",
});

const requested = (actions: Action[]): HookEvent<"actions.requested"> => ({
  data: { actions, sequence: 3, stepIndex: 0, turnId: "turn-1" },
  meta,
  type: "actions.requested",
});

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("VERCEL", "1");
});

describe("mirror warm hook", () => {
  it("subscribes to skill loads and turn starts", () => {
    expect(Object.keys(hook.events ?? {}).toSorted()).toEqual([
      "actions.requested",
      "turn.started",
    ]);
  });

  it("does not touch the sandbox at turn start in sessions that never used SQL", async () => {
    const { ctx, getSandbox } = warmContext();
    await warmOnTurnStart(ctx);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("ignores other skills", async () => {
    const { ctx, getSandbox } = warmContext();
    await warmOnSkillLoad(requested([loadSkill("contentful_api")]), ctx);
    await warmOnTurnStart(ctx);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("warms when the SQL skill loads, then at the start of each later turn", async () => {
    const { ctx, spawn } = warmContext();
    await warmOnSkillLoad(
      requested([loadSkill("contentful_api"), loadSkill(MIRROR_SQL_SKILL)]),
      ctx
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({ command: MIRROR_PREFETCH_COMMAND });

    await warmOnTurnStart(ctx);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("remembers SQL use without warming in local sessions", async () => {
    vi.stubEnv("VERCEL", "");
    const { ctx, getSandbox } = warmContext();
    await warmOnSkillLoad(requested([loadSkill(MIRROR_SQL_SKILL)]), ctx);
    await warmOnTurnStart(ctx);
    expect(getSandbox).not.toHaveBeenCalled();
    expect(testState.get("contentful.mirror-sql-used")).toBe(true);
  });
});
