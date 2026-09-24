import type { ContextReader } from "#context/key.js";
import type { HarnessToolMap } from "#harness/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { isTaskCancelTool } from "#tasks/cancel-tool.js";
import { renderTasksInstruction } from "#tasks/render.js";
import { isTaskWaitTool } from "#tasks/wait-tool.js";

// What a session offers the model for detached tasks: `task_wait`,
// `task_cancel`, and the static tasks block, together or not at all.

/**
 * The static tasks system block, or `undefined` when the session's agent
 * cannot start a detached task: it has no agent tool (declared, remote,
 * dynamic, or the built-in `agent`) and no workflow tool that is not
 * attached. It reads only the configured tools and dynamic resolvers, which
 * do not change mid-session, so the tools and the system prefix stay stable
 * for the prompt cache.
 */
export function resolveTasksInstruction(input: {
  readonly ctx: ContextReader | undefined;
  readonly tools: HarnessToolMap;
}): string | undefined {
  const dynamicResolvers = input.ctx?.get(BundleKey)?.subagentRegistry?.dynamicResolvers ?? [];
  let agents = dynamicResolvers.some((resolver) => resolver.tool !== false);
  let workflows = false;
  for (const tool of input.tools.values()) {
    if (isTaskCancelTool(tool) || isTaskWaitTool(tool)) continue;
    if (tool.workflowId === AGENT_TASK_WORKFLOW_ID) agents = true;
    else if (tool.workflowId !== undefined && tool.attached !== true) workflows = true;
  }
  return agents || workflows ? renderTasksInstruction({ agents }) : undefined;
}

/** The tools without `task_wait` and `task_cancel`, for a session that cannot start a detached task. */
export function withoutTaskTools(tools: HarnessToolMap): HarnessToolMap {
  const next = new Map(tools);
  for (const [name, tool] of tools) {
    if (isTaskCancelTool(tool) || isTaskWaitTool(tool)) next.delete(name);
  }
  return next.size === tools.size ? tools : next;
}
