import type { ContextReader } from "#context/key.js";
import { DelegatedSessionKey, ModeKey, ScheduleIdKey, TurnScheduleIdKey } from "#context/keys.js";
import type { HarnessToolMap } from "#harness/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { RunMode } from "#shared/run-mode.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { isTaskCancelTool } from "#tasks/cancel-tool.js";
import { renderBackgroundTasksInstruction } from "#tasks/render.js";
import { BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";

// Which sessions and turns can move work to the background. The one place
// that decides it, for the model's tools, the owner, and detach.

/**
 * A root session in conversation mode that no caller created. It is decided
 * from facts fixed at creation, so the tools and instructions it implies do
 * not change mid-session, even when a later turn arrives with a caller.
 */
export function isInteractiveRootSession(
  ctx: ContextReader | undefined,
  mode: RunMode | undefined = ctx?.get(ModeKey),
): boolean {
  return mode === "conversation" && ctx?.get(DelegatedSessionKey) !== true;
}

/**
 * A turn of an interactive root session that a schedule did not start. Only
 * such a turn detaches waited calls or runs agent calls in the background; a
 * scheduled turn waits for every call, so it posts one final reply. A
 * schedule starts the first turn of a session it created, and any turn its
 * delivery starts in an existing session.
 */
export function isInteractiveRootTurn(ctx: ContextReader, turnSequence: number): boolean {
  if (!isInteractiveRootSession(ctx)) return false;
  if (ctx.get(TurnScheduleIdKey) !== undefined) return false;
  return !(turnSequence === 0 && ctx.get(ScheduleIdKey) !== undefined);
}

/** What a session offers the model for background work. */
export interface BackgroundTaskSurface {
  /** Agent tools take the model-facing `background` parameter. */
  readonly backgroundParameter: boolean;
  /** The model gets `task_cancel`. */
  readonly taskCancel: boolean;
  /** The static background-tasks system block. */
  readonly instruction?: string;
}

/**
 * Decides the background surface, which is static per session so the tools
 * and system prefix stay stable for the prompt cache. It applies to an
 * interactive root session with any agent tool (including dynamic subagents
 * it may resolve later) or workflow tool, and to any session with a
 * `detach: true` tool. A turn a schedule started still offers `background`;
 * the owner waits on such calls instead.
 */
export function resolveBackgroundTaskSurface(input: {
  readonly ctx: ContextReader | undefined;
  readonly mode: RunMode;
  readonly tools: HarnessToolMap;
}): BackgroundTaskSurface {
  const interactiveRoot = isInteractiveRootSession(input.ctx, input.mode);
  const dynamicResolvers = input.ctx?.get(BundleKey)?.subagentRegistry?.dynamicResolvers ?? [];
  let agents = dynamicResolvers.some((resolver) => resolver.tool !== false);
  let workflows = false;
  let detach = false;
  for (const tool of input.tools.values()) {
    if (isTaskCancelTool(tool)) continue;
    if (tool.detach === true) detach = true;
    if (tool.workflowId === AGENT_TASK_WORKFLOW_ID) agents = true;
    else if (tool.workflowId !== undefined) workflows = true;
  }
  const enabled = detach || (interactiveRoot && (agents || workflows));
  if (!enabled) return { backgroundParameter: false, taskCancel: false };
  return {
    backgroundParameter: interactiveRoot,
    instruction: renderBackgroundTasksInstruction({ agents }),
    taskCancel: true,
  };
}

/**
 * Applies the surface to one model step's tools: agent tools (declared,
 * remote, dynamic, and the built-in `agent`) gain `background`, and
 * `task_cancel` is dropped where background work cannot exist.
 */
export function applyBackgroundTaskSurface(
  tools: HarnessToolMap,
  surface: BackgroundTaskSurface,
): HarnessToolMap {
  if (surface.taskCancel && !surface.backgroundParameter) return tools;
  const next = new Map(tools);
  for (const [name, tool] of tools) {
    if (!surface.taskCancel && isTaskCancelTool(tool)) next.delete(name);
    else if (surface.backgroundParameter && tool.workflowId === AGENT_TASK_WORKFLOW_ID) {
      next.set(name, { ...tool, inputSchema: BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA });
    }
  }
  return next;
}
