import type { ToolSet, TypedToolCall } from "ai";

import type { ActionPresentationByCallId } from "#protocol/message.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/coordination.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { normalizeActivityText } from "#shared/activity-text.js";
import { parseJsonObject } from "#shared/json.js";

export interface RuntimeActionRequestProjection {
  readonly action: RuntimeActionRequest;
  readonly activityLabel?: string;
}

export function createPresentedRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): RuntimeActionRequestProjection {
  const action = createRuntimeActionRequestFromToolCall(input);
  const start = input.tools.get(input.toolCall.toolName)?.activity?.start;
  if (start === undefined) return { action };
  try {
    const label = normalizeActivityText(start(parseJsonObject(action.input)));
    return label === "" ? { action } : { action, activityLabel: label };
  } catch {
    return { action };
  }
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
