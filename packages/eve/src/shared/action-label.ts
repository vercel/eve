import type { ActionPresentationByCallId } from "#protocol/message.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { displayTitle } from "#shared/display-name.js";

/**
 * How a call reads to people on every surface: the label its entry's definition
 * gives it, or the entry's display title. A call made through `eve__execute`
 * arrives as the call to its entry, so it reads like a direct call.
 */
export function actionLabel(
  action: RuntimeActionRequest,
  presentation: ActionPresentationByCallId | undefined,
): string {
  return presentation?.[action.callId]?.label ?? displayTitle(actionRequestName(action));
}

/** The calls people see: the model waiting on or stopping its own tasks stays out of view. */
export function visibleActions<T extends RuntimeActionRequest>(actions: readonly T[]): T[] {
  return actions.filter(
    (action) => !(action.kind === "tool-call" && isTaskControlTool(action.toolName)),
  );
}
