import type { ActionPresentationByCallId } from "#protocol/message.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { normalizePresentationText } from "#shared/presentation-text.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export function projectResultPresentation(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionPresentationByCallId | undefined {
  return projectPresentationText(definition?.label?.complete, callId, input, output);
}

export function projectDeltaPresentation(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionPresentationByCallId | undefined {
  return projectPresentationText(definition?.label?.delta, callId, input, output);
}

function projectPresentationText(
  project: ((input: unknown, value: unknown) => string) | undefined,
  callId: string,
  input: JsonObject | undefined,
  value: unknown,
): ActionPresentationByCallId | undefined {
  if (project === undefined || input === undefined) return undefined;
  try {
    const text = normalizePresentationText(project(parseJsonObject(input), value));
    return text === "" ? undefined : { [callId]: { label: text } };
  } catch {
    return undefined;
  }
}
