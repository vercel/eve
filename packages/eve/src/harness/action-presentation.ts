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
  /** The tool set `label: false`, so activity leaves the call out. */
  readonly hidden?: true;
}

export function createPresentedRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolLookup;
}): RuntimeActionRequestProjection {
  const action = createRuntimeActionRequestFromToolCall(input);
  const definition = input.tools.get(input.toolCall.toolName);
  if (definition?.label === false) return { action, hidden: true };
  const presentationLabel = projectToolLabel(definition, "start", action.input);
  return presentationLabel === undefined ? { action } : { action, presentationLabel };
}

/** Label callbacks share normalization, detached input, and failure isolation. */
export function projectToolLabel(
  definition: { readonly label?: HarnessToolDefinition["label"] } | undefined,
  phase: "start" | "delta" | "complete",
  input: unknown,
  output?: unknown,
): string | undefined {
  const labels = definition?.label;
  const project = labels === false ? undefined : labels?.[phase];
  if (project === undefined || input === undefined) return undefined;
  try {
    const label = normalizePresentationText(project(parseJsonObject(input), output));
    return label === "" ? undefined : label;
  } catch {
    return undefined;
  }
}
