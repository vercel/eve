import { renderTextInteraction } from "#channel/resolve-text.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import type { JsonObject } from "#shared/json.js";

/** Renders eve input requests as one user-visible Linear elicitation body. */
export function renderLinearInteractions(requests: readonly Interaction[]): string {
  return requests.map(renderLinearInteraction).join("\n\n");
}

/** Builds native Linear select metadata for a single input request with options. */
export function linearInteractionSignal(requests: readonly Interaction[]): {
  readonly signal?: "select";
  readonly signalMetadata?: JsonObject;
} {
  const request = requests.length === 1 ? requests[0] : undefined;
  if (request?.request.options === undefined || request.request.options.length === 0) return {};

  return {
    signal: "select",
    signalMetadata: {
      options: request.request.options.map((option) => ({
        label: option.label,
        value: option.id,
      })),
    },
  };
}

function renderLinearInteraction(request: Interaction): string {
  const body = renderTextInteraction(request.request);
  return request.request.allowFreeform === true
    ? `${body}\n\nYou can also reply with a custom answer.`
    : body;
}
