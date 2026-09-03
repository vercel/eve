import type { ActionPresentationByCallId } from "#protocol/message.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";

export interface RuntimeActionRequestProjection {
  readonly action: RuntimeActionRequest;
  readonly activityLabel?: string;
}

export function collectActionActivityLabels(
  actions: readonly RuntimeActionRequestProjection[],
): ActionPresentationByCallId | undefined {
  const presentation = Object.fromEntries(
    actions.flatMap(({ action, activityLabel }) =>
      activityLabel === undefined ? [] : [[action.callId, { label: activityLabel }]],
    ),
  );
  return Object.keys(presentation).length === 0 ? undefined : presentation;
}
