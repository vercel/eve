import type { ToolSet, TypedToolCall } from "ai";

import type { ActionPresentationByCallId } from "#protocol/message.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/coordination.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { normalizePresentationText } from "#shared/presentation-text.js";
import { parseJsonObject } from "#shared/json.js";

export interface RuntimeActionRequestProjection {
  readonly action: RuntimeActionRequest;
  readonly presentationLabel?: string;
}

export function createPresentedRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): RuntimeActionRequestProjection {
  const action = createRuntimeActionRequestFromToolCall(input);
  const start = input.tools.get(input.toolCall.toolName)?.label?.start;
  if (start === undefined) return { action };
  try {
    const label = normalizePresentationText(start(parseJsonObject(action.input)));
    return label === "" ? { action } : { action, presentationLabel: label };
  } catch {
    return { action };
  }
}

export function collectActionPresentation(
  actions: readonly RuntimeActionRequestProjection[],
): ActionPresentationByCallId | undefined {
  const presentation = Object.fromEntries(
    actions.flatMap(({ action, presentationLabel }) =>
      presentationLabel === undefined ? [] : [[action.callId, { label: presentationLabel }]],
    ),
  );
  return Object.keys(presentation).length === 0 ? undefined : presentation;
}
