/**
 * Per-step bookkeeping for a model step's text and requested actions. Slack
 * shows the text as typing status while the step requests actions, and posts
 * it once the step completes if the step's only action was `task_wait`.
 */
import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";
import { TASK_WAIT_TOOL_NAME } from "#execution/tasks/calls.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";

/**
 * Buffers a `"tool-calls"` step's text until the step completes. A step
 * flushes its text before each action and again at its end, so runs append.
 */
export function bufferToolCallMessage(state: SlackChannelState, message: string | null): void {
  if (message === null || message.trim().length === 0) return;
  const buffered = state.pendingToolCallMessage;
  state.pendingToolCallMessage = buffered ? `${buffered}\n${message}` : message;
}

/** Only a plain tool call can be `task_wait`, so other kinds record their kind. */
function requestedActionName(action: RuntimeActionRequest): string {
  if (action.kind === "tool-call") return action.toolName;
  return action.kind;
}

/** Collects the step's actions, which may arrive over several `actions.requested` events. */
export function recordStepActions(
  state: SlackChannelState,
  actions: readonly RuntimeActionRequest[],
): void {
  const names = actions.map(requestedActionName);
  state.stepActionNames = [...(state.stepActionNames ?? []), ...names];
}

/**
 * The step's text, offered as typing status only for the step's first actions.
 * The channel records each batch before its handler runs, so the first batch
 * is the one that makes up every recorded name.
 */
export function stepNarration(
  state: SlackChannelState,
  actions: readonly RuntimeActionRequest[],
): string | null {
  const isFirstBatch = (state.stepActionNames?.length ?? 0) === actions.length;
  if (!isFirstBatch) return null;
  return state.pendingToolCallMessage ?? null;
}

export function clearPendingStep(state: SlackChannelState): void {
  state.pendingToolCallMessage = null;
  state.stepActionNames = null;
}

function isOnlyTaskWait(actionNames: readonly string[]): boolean {
  return actionNames.length === 1 && actionNames[0] === TASK_WAIT_TOOL_NAME;
}

function isScheduleTurn(): boolean {
  return contextStorage.getStore()?.get(ScheduleIdKey) !== undefined;
}

/**
 * Ends the step and returns its text when its only action was `task_wait`, so
 * a person sees what is running while the turn waits. Returns `null` for any
 * other step and for a schedule's turn, whose reader gets only the final reply.
 */
export function takeTextBeforeTaskWait(state: SlackChannelState): string | null {
  const text = state.pendingToolCallMessage ?? null;
  const actionNames = state.stepActionNames ?? [];
  clearPendingStep(state);
  if (!isOnlyTaskWait(actionNames) || isScheduleTurn()) return null;
  return text;
}
