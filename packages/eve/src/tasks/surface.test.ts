import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { DelegatedSessionKey, ModeKey, ScheduleIdKey } from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import { renderTasksInstruction } from "#tasks/render.js";
import { resolveTasksInstruction, withoutTaskTools } from "#tasks/surface.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";

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
const ASK = tool("ask_question", { attached: true, workflowId: "workflow//ask" });
const TASK_CANCEL = tool("task_cancel", { workflowId: TASK_CANCEL_WORKFLOW_ID });
const TASK_WAIT = tool("task_wait", { workflowId: TASK_WAIT_WORKFLOW_ID });

function tools(...entries: HarnessToolDefinition[]) {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

function withDynamicSubagents(ctx: ContextContainer): void {
  ctx.set(BundleKey, {
    subagentRegistry: { dynamicResolvers: [{ kind: "subagent", name: "specialist" }] },
  } as never);
}

describe("resolveTasksInstruction", () => {
  it("offers the block with an agent tool or a workflow tool that is not attached", () => {
    expect(resolveTasksInstruction({ ctx: context(), tools: tools(RESEARCHER) })).toBe(
      renderTasksInstruction({ agents: true }),
    );
    expect(resolveTasksInstruction({ ctx: context(), tools: tools(DEPLOY) })).toBe(
      renderTasksInstruction({ agents: false }),
    );
    expect(resolveTasksInstruction({ ctx: context(), tools: tools() })).toBeUndefined();
  });

  it("does not count attached workflow tools, which never start a detached task", () => {
    expect(
      resolveTasksInstruction({ ctx: context(), tools: tools(ASK, TASK_CANCEL, TASK_WAIT) }),
    ).toBeUndefined();
  });

  it("counts dynamic subagents the agent declares, even before one resolves", () => {
    expect(
      resolveTasksInstruction({
        ctx: context(withDynamicSubagents),
        tools: tools(TASK_CANCEL, TASK_WAIT),
      }),
    ).toBe(renderTasksInstruction({ agents: true }));
  });

  it("offers the same block in every session kind", () => {
    const block = renderTasksInstruction({ agents: true });
    for (const ctx of [
      context((next) => next.set(DelegatedSessionKey, true)),
      context((next) => next.set(ModeKey, "task")),
      context((next) => next.set(ScheduleIdKey, "daily-report")),
    ]) {
      expect(resolveTasksInstruction({ ctx, tools: tools(RESEARCHER) })).toBe(block);
    }
  });
});

describe("withoutTaskTools", () => {
  it("drops task_wait and task_cancel and keeps every other tool as is", () => {
    const kept = withoutTaskTools(tools(ASK, TASK_CANCEL, TASK_WAIT));
    expect([...kept.keys()]).toEqual(["ask_question"]);
    expect(kept.get("ask_question")).toBe(ASK);

    const unchanged = tools(RESEARCHER, DEPLOY);
    expect(withoutTaskTools(unchanged)).toBe(unchanged);
  });
});
