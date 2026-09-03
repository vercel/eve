import type {
  ActionPresentation,
  ActionPresentationByCallId,
  ActionPresentationState,
} from "#protocol/message.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { normalizePresentationText } from "#shared/presentation-text.js";
import { isPresentationStateKey, isPresentationStateValue } from "#shared/presentation-state.js";
import { parseJsonValue, parseJsonObject, type JsonObject } from "#shared/json.js";

export function projectResultPresentation(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionPresentationByCallId | undefined {
  if (definition?.label?.complete === undefined || input === undefined) return undefined;
  try {
    const complete = definition.label.complete(parseJsonObject(input), output);
    const presentation =
      typeof complete === "string"
        ? { label: normalizePresentationText(complete) || undefined }
        : {
            label:
              complete.label === undefined
                ? undefined
                : normalizePresentationText(complete.label) || undefined,
            state: projectRenderingState(definition.name, complete.renderingState),
          };
    return hasPresentation(presentation) ? { [callId]: presentation } : undefined;
  } catch {
    return undefined;
  }
}

export function projectDeltaPresentation(
  definition: HarnessToolDefinition | undefined,
  callId: string,
  input: JsonObject | undefined,
  output: unknown,
): ActionPresentationByCallId | undefined {
  if (definition?.label?.delta === undefined || input === undefined) return undefined;
  try {
    const label = normalizePresentationText(definition.label.delta(parseJsonObject(input), output));
    return label === "" ? undefined : { [callId]: { label } };
  } catch {
    return undefined;
  }
}

function projectRenderingState(key: string, state: unknown): ActionPresentationState | undefined {
  if (state === undefined || !isPresentationStateKey(key)) return undefined;
  try {
    const value = parseJsonValue(state);
    return isPresentationStateValue(value) ? { key, value } : undefined;
  } catch {
    return undefined;
  }
}

function hasPresentation(presentation: ActionPresentation): boolean {
  return presentation.label !== undefined || presentation.state !== undefined;
}
