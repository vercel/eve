import type { ToolSet, TypedToolCall } from "ai";

import type { ActionPresentationByCallId } from "#protocol/message.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/coordination.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
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
  const presentationLabel = projectToolStartLabel(
    input.tools.get(input.toolCall.toolName),
    action.input,
  );
  return presentationLabel === undefined ? { action } : { action, presentationLabel };
}

/** Calls a tool's label callback with a detached, JSON-safe input copy. */
export function projectToolStartLabel(
  definition: { readonly label?: HarnessToolDefinition["label"] } | undefined,
  input: unknown,
): string | undefined {
  const start = definition?.label?.start;
  if (start === undefined) return undefined;
  try {
    const label = normalizePresentationText(start(parseJsonObject(input)));
    return label === "" ? undefined : label;
  } catch {
    return undefined;
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
