import type { InputRequest } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";

/** Renders eve input requests as one user-visible Linear elicitation body. */
export function renderLinearInputRequests(requests: readonly InputRequest[]): string {
  return requests.map(renderLinearInputRequest).join("\n\n");
}

/** Builds native Linear select metadata for a single input request with options. */
export function linearInputRequestSignal(requests: readonly InputRequest[]): {
  readonly signal?: "select";
  readonly signalMetadata?: JsonObject;
} {
  const request = requests.length === 1 ? requests[0] : undefined;
  if (request?.options === undefined || request.options.length === 0) return {};

  return {
    signal: "select",
    signalMetadata: {
      options: request.options.map((option) => ({
        label: option.label,
        value: option.id,
      })),
    },
  };
}

function renderLinearInputRequest(request: InputRequest): string {
  const lines = [request.prompt];
  if (request.options !== undefined && request.options.length > 0) {
    lines.push(
      "",
      ...request.options.map((option, index) => {
        const description = option.description ? ` - ${option.description}` : "";
        return `${index + 1}. ${option.label}${description}`;
      }),
    );
  }
  if (request.allowFreeform === true) {
    lines.push("", "You can also reply with a custom answer.");
  }
  return lines.join("\n");
}
