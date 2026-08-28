import type { RuntimeActionRequest } from "#shared/action-types.js";

export interface RuntimeActionRequestProjection {
  readonly action: RuntimeActionRequest;
  readonly activityLabel?: string;
}

export type ActionActivityLabels = Readonly<Record<string, string>>;

export function collectActionActivityLabels(
  actions: readonly RuntimeActionRequestProjection[],
): ActionActivityLabels | undefined {
  const labels = Object.fromEntries(
    actions.flatMap(({ action, activityLabel }) =>
      activityLabel === undefined ? [] : [[action.callId, activityLabel]],
    ),
  );
  return Object.keys(labels).length === 0 ? undefined : labels;
}
