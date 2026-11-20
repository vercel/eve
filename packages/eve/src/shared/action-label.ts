import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";

export function actionLabel(
  action: RuntimeActionRequest,
  presentation: ActionPresentationByCallId | undefined,
): string {
  return presentation?.[action.callId]?.label ?? displayTitle(actionRequestName(action));
}

export interface ActionPresentation {
  readonly label?: string;
}
export type ActionPresentationByCallId = Readonly<Record<string, ActionPresentation>>;
