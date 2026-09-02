import type { ActionActivityLabels } from "#harness/action-activity.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { normalizeActivityText } from "#shared/activity-text.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export function projectResultActivity(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionActivityLabels | undefined {
  return projectActivityText(definition?.activityResult, callId, input, output);
}

export function projectUpdateActivity(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionActivityLabels | undefined {
  return projectActivityText(definition?.activityUpdate, callId, input, output);
}

function projectActivityText(
  project: ((input: unknown, value: unknown) => string) | undefined,
  callId: string,
  input: JsonObject | undefined,
  value: unknown,
): ActionActivityLabels | undefined {
  if (project === undefined || input === undefined) return undefined;
  try {
    const text = normalizeActivityText(project(parseJsonObject(input), value));
    return text === "" ? undefined : { [callId]: text };
  } catch {
    return undefined;
  }
}
