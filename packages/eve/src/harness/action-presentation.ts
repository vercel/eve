import type { ToolSet, TypedToolCall } from "ai";

import { createRuntimeActionRequestFromToolCall } from "#harness/coordination.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolLookup } from "#harness/types.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { normalizePresentationText } from "#shared/presentation-text.js";
import { parseJsonObject } from "#shared/json.js";

export interface RuntimeActionRequestProjection {
  readonly action: RuntimeActionRequest;
  readonly presentationLabel?: string;
}

export function createPresentedRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolLookup;
}): RuntimeActionRequestProjection {
  const action = createRuntimeActionRequestFromToolCall(input);
  const presentationLabel = projectToolLabel(
    input.tools.get(input.toolCall.toolName),
    "start",
    action.input,
  );
  return presentationLabel === undefined ? { action } : { action, presentationLabel };
}

/** Label callbacks share normalization, detached input, and failure isolation. */
export function projectToolLabel(
  definition: { readonly label?: HarnessToolDefinition["label"] } | undefined,
  phase: "start" | "delta" | "complete",
  input: unknown,
  output?: unknown,
): string | undefined {
  const project = definition?.label?.[phase];
  if (project === undefined || input === undefined) return undefined;
  try {
    const label = normalizePresentationText(project(parseJsonObject(input), output));
    return label === "" ? undefined : label;
  } catch {
    return undefined;
  }
}
