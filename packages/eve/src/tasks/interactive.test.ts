import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  DelegatedSessionKey,
  ModeKey,
  ScheduleIdKey,
  SessionCallbackKey,
  TurnScheduleIdKey,
} from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import {
  applyBackgroundTaskSurface,
  isInteractiveRootSession,
  isInteractiveRootTurn,
  resolveBackgroundTaskSurface,
} from "#tasks/interactive.js";
import { renderBackgroundTasksInstruction } from "#tasks/render.js";
import {
  BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";

function context(configure: (ctx: ContextContainer) => void = () => {}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ModeKey, "conversation");
  configure(ctx);
  return ctx;
}

function tool(name: string, fields: Partial<HarnessToolDefinition> = {}): HarnessToolDefinition {
  return { description: name, inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA, name, ...fields };
}

const RESEARCHER = tool("researcher", { workflowId: AGENT_TASK_WORKFLOW_ID });
const DEPLOY = tool("deploy", { workflowId: "workflow//deploy" });
const REMIND = tool("remind", { detach: true, workflowId: "workflow//remind" });
const TASK_CANCEL = tool("task_cancel", { workflowId: TASK_CANCEL_WORKFLOW_ID });

function tools(...entries: HarnessToolDefinition[]) {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

function withDynamicSubagents(ctx: ContextContainer): void {
  ctx.set(BundleKey, {
    subagentRegistry: { dynamicResolvers: [{ kind: "subagent", name: "specialist" }] },
  } as never);
}

describe("isInteractiveRootSession", () => {
  it("holds for a root conversation session and excludes task mode and delegated sessions", () => {
    expect(isInteractiveRootSession(context())).toBe(true);
    expect(isInteractiveRootSession(context((ctx) => ctx.set(ModeKey, "task")))).toBe(false);
    expect(isInteractiveRootSession(context((ctx) => ctx.set(DelegatedSessionKey, true)))).toBe(
      false,
    );
  });

  it("does not change when a later turn of a root session binds a caller callback", () => {
    const ctx = context((next) =>
      next.set(SessionCallbackKey, { callId: "call-1", url: "https://caller.example" } as never),
    );
    expect(isInteractiveRootSession(ctx)).toBe(true);
  });
});

describe("isInteractiveRootTurn", () => {
  it("excludes the turn a schedule started, but not later turns in its session", () => {
    const scheduled = context((ctx) => ctx.set(ScheduleIdKey, "daily-report"));
    expect(isInteractiveRootTurn(scheduled, 0)).toBe(false);
    expect(isInteractiveRootTurn(scheduled, 1)).toBe(true);
  });

  it("excludes a turn a schedule's delivery started in an existing session", () => {
    expect(
      isInteractiveRootTurn(
        context((ctx) => ctx.set(TurnScheduleIdKey, "digest")),
        4,
      ),
    ).toBe(false);
  });

  it("excludes delegated sessions", () => {
    expect(
      isInteractiveRootTurn(
        context((ctx) => ctx.set(DelegatedSessionKey, true)),
        2,
      ),
    ).toBe(false);
  });
});

describe("resolveBackgroundTaskSurface", () => {
  it("offers background, task_cancel, and the block in an interactive root session with an agent or workflow tool", () => {
    for (const available of [tools(RESEARCHER), tools(DEPLOY)]) {
      expect(
        resolveBackgroundTaskSurface({ ctx: context(), mode: "conversation", tools: available }),
      ).toMatchObject({ backgroundParameter: true, taskCancel: true });
    }
    expect(
      resolveBackgroundTaskSurface({ ctx: context(), mode: "conversation", tools: tools() }),
    ).toEqual({ backgroundParameter: false, taskCancel: false });
  });

  it("counts dynamic subagents the agent declares, even before one resolves", () => {
    const surface = resolveBackgroundTaskSurface({
      ctx: context(withDynamicSubagents),
      mode: "conversation",
      tools: tools(TASK_CANCEL),
    });

    expect(surface).toEqual({
      backgroundParameter: true,
      instruction: renderBackgroundTasksInstruction({ agents: true }),
      taskCancel: true,
    });
  });

  it("keeps the same surface in a session a schedule created", () => {
    const surface = resolveBackgroundTaskSurface({
      ctx: context((ctx) => ctx.set(ScheduleIdKey, "daily-report")),
      mode: "conversation",
      tools: tools(RESEARCHER),
    });
    expect(surface.backgroundParameter).toBe(true);
  });

  it("offers only task_cancel and the block elsewhere, and only for a detach: true tool", () => {
    const delegated = context((ctx) => ctx.set(DelegatedSessionKey, true));
    expect(
      resolveBackgroundTaskSurface({
        ctx: delegated,
        mode: "conversation",
        tools: tools(RESEARCHER, REMIND),
      }),
    ).toEqual({
      backgroundParameter: false,
      instruction: renderBackgroundTasksInstruction({ agents: true }),
      taskCancel: true,
    });
    expect(
      resolveBackgroundTaskSurface({ ctx: delegated, mode: "task", tools: tools(RESEARCHER) }),
    ).toEqual({ backgroundParameter: false, taskCancel: false });
  });
});

describe("applyBackgroundTaskSurface", () => {
  it("adds background to agent tools and drops task_cancel where it has nothing to stop", () => {
    const applied = applyBackgroundTaskSurface(tools(RESEARCHER, DEPLOY, TASK_CANCEL), {
      backgroundParameter: true,
      taskCancel: true,
    });
    expect(applied.get("researcher")?.inputSchema).toBe(BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA);
    expect(applied.get("deploy")).toBe(DEPLOY);
    expect(applied.has("task_cancel")).toBe(true);

    const none = applyBackgroundTaskSurface(tools(RESEARCHER, TASK_CANCEL), {
      backgroundParameter: false,
      taskCancel: false,
    });
    expect([...none.keys()]).toEqual(["researcher"]);
    expect(none.get("researcher")).toBe(RESEARCHER);
  });
});
