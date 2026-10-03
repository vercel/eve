/**
 * Typing-indicator text for the turn's calls. It uses each call's start label,
 * the same text its task card row shows, so both surfaces name a call the same
 * way: `Run pnpm test`, `researcher: Find the March incidents`.
 */
import type { ActionPresentationByCallId } from "#protocol/message.js";
import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { displayName, displayTitle } from "#shared/display-name.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";

/** The call's start label, or its tool or agent display title. */
export function actionLabel(
  action: RuntimeActionRequest,
  presentation: ActionPresentationByCallId | undefined,
): string {
  return presentation?.[action.callId]?.label ?? displayTitle(actionRequestName(action));
}

/** The first call's label, plus `+N more` when the model made several calls in one step. */
export function withMoreCalls(label: string, count: number): string {
  return count <= 1 ? label : `${label} +${String(count - 1)} more`;
}

/**
 * `Waiting on researcher...` for one named task, otherwise a count such as
 * `Waiting on 3 tasks...`. The agent's own copy is never named, since its
 * name, `agent`, says nothing.
 */
export function waitingOnTasks(names: readonly string[]): string {
  const [only] = names;
  if (names.length === 1 && only !== AGENT_TOOL_NAME) return `Waiting on ${displayName(only!)}...`;
  return names.length === 1
    ? "Waiting on a task..."
    : `Waiting on ${String(names.length)} tasks...`;
}

/**
 * `Reviewing researcher's results...` when every settled task called the same
 * named agent, otherwise `Reviewing results...`. `null` stands for a task
 * that isn't a named agent call.
 */
export function reviewingResults(names: readonly (string | null)[]): string {
  const [first] = names;
  const named = first != null && first !== AGENT_TOOL_NAME && names.every((name) => name === first);
  return named ? `Reviewing ${displayName(first)}'s results...` : "Reviewing results...";
}
