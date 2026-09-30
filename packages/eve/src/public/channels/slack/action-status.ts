/**
 * Typing-indicator text for the turn's calls. It uses each call's start label,
 * the same text its task card row shows, so both surfaces name a call the same
 * way: `Run pnpm test`, `researcher: Find the March incidents`.
 */
import type { ActionPresentationByCallId } from "#protocol/message.js";
import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";

/**
 * The first call's label, or its tool or agent name, plus `+N more` when the
 * model requested several calls at once.
 */
export function describeActionRequests(
  actions: readonly RuntimeActionRequest[],
  presentation: ActionPresentationByCallId | undefined,
): string {
  const [first] = actions;
  if (first === undefined) return "Working...";
  const label = presentation?.[first.callId]?.label ?? actionRequestName(first);
  return actions.length === 1 ? label : `${label} +${String(actions.length - 1)} more`;
}

/**
 * `Waiting on researcher...` for one named task, otherwise a count such as
 * `Waiting on 3 tasks...`. The agent's own copy is never named, since its
 * name, `agent`, says nothing.
 */
export function waitingOnTasks(names: readonly string[]): string {
  const [only] = names;
  if (names.length === 1 && only !== AGENT_TOOL_NAME) return `Waiting on ${only!}...`;
  return names.length === 1
    ? "Waiting on a task..."
    : `Waiting on ${String(names.length)} tasks...`;
}
