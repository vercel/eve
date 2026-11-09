import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";

/**
 * How a call reads to people on every surface: the label its entry's definition
 * gives it, or the entry's display title. A call made through `eve__tool` or
 * `eve__skill` arrives as the call to its entry, so it reads like a direct call.
 */
export function actionLabel(
  action: RuntimeActionRequest,
  presentation: ActionPresentationByCallId | undefined,
): string {
  return presentation?.[action.callId]?.label ?? displayTitle(actionRequestName(action));
}

/** A tool's authored label for a call or output snapshot. */
export interface ActionPresentation {
  readonly label?: string;
}
export type ActionPresentationByCallId = Readonly<Record<string, ActionPresentation>>;
