import type { ActionPresentationByCallId } from "#protocol/message.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { normalizeActivityText } from "#shared/activity-text.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export function projectResultActivity(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionPresentationByCallId | undefined {
  return projectActivityText(definition?.activity?.complete, callId, input, output);
}

export function projectUpdateActivity(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionPresentationByCallId | undefined {
  return projectActivityText(definition?.activity?.delta, callId, input, output);
}

function projectActivityText(
  project: ((input: unknown, value: unknown) => string) | undefined,
  callId: string,
  input: JsonObject | undefined,
  value: unknown,
): ActionPresentationByCallId | undefined {
  if (project === undefined || input === undefined) return undefined;
  try {
    const text = normalizeActivityText(project(parseJsonObject(input), value));
    return text === "" ? undefined : { [callId]: { label: text } };
  } catch {
    return undefined;
  }
}
