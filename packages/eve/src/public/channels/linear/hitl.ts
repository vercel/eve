import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { LinearAgentActivityRecord } from "#public/channels/linear/api.js";
import type { InputOption, InputRequest, InputResponse } from "#runtime/input/types.js";

/** Hidden marker embedded in eve-created Linear elicitation bodies. */
export const LINEAR_HITL_MARKER_PREFIX = "<!-- eve-input:";
export const LINEAR_HITL_MARKER_SUFFIX = " -->";

interface LinearHitlMarkerPayload {
  requests: readonly LinearStoredInputRequest[];
}

interface LinearStoredInputRequest {
  allowFreeform?: boolean;
  display?: InputRequest["display"];
  options?: readonly InputOption[];
  prompt: string;
  requestId: string;
}

/** Renders eve input requests as one Linear elicitation body. */
export function renderLinearInputRequests(requests: readonly InputRequest[]): string {
  const marker = encodeLinearHitlMarker(requests.map(storableRequest));
  const rendered = requests.map(renderLinearInputRequest).join("\n\n");
  return `${rendered}\n\n${marker}`;
}

/** Resolves a Linear user prompt against the latest eve-created elicitation marker. */
export function resolveLinearPromptInputResponses(input: {
  readonly activities: readonly LinearAgentActivityRecord[];
  readonly body: string;
}): readonly InputResponse[] {
  const marker = findLatestLinearHitlMarker(input.activities);
  if (marker === null) return [];
  return resolveTextToResponses(input.body, marker.requests.map(toInputRequest));
}

/** Strips eve's hidden HITL marker from a body before user-facing assertions/logging. */
export function stripLinearHitlMarker(body: string): string {
  const start = body.indexOf(LINEAR_HITL_MARKER_PREFIX);
  if (start === -1) return body;
  return body.slice(0, start).trimEnd();
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

function storableRequest(request: InputRequest): LinearStoredInputRequest {
  const stored: LinearStoredInputRequest = {
    prompt: request.prompt,
    requestId: request.requestId,
  };
  if (request.allowFreeform !== undefined) stored.allowFreeform = request.allowFreeform;
  if (request.display !== undefined) stored.display = request.display;
  if (request.options !== undefined) stored.options = request.options;
  return stored;
}

function toInputRequest(request: LinearStoredInputRequest): InputRequest {
  const inputRequest: InputRequest = {
    action: {
      callId: `linear-input:${request.requestId}`,
      input: {},
      kind: "tool-call",
      toolName: "linear_input",
    },
    prompt: request.prompt,
    requestId: request.requestId,
  };
  if (request.allowFreeform !== undefined) inputRequest.allowFreeform = request.allowFreeform;
  if (request.display !== undefined) inputRequest.display = request.display;
  if (request.options !== undefined) inputRequest.options = [...request.options];
  return inputRequest;
}

function encodeLinearHitlMarker(requests: readonly LinearStoredInputRequest[]): string {
  const encoded = Buffer.from(JSON.stringify({ requests }), "utf8").toString("base64url");
  return `${LINEAR_HITL_MARKER_PREFIX}${encoded}${LINEAR_HITL_MARKER_SUFFIX}`;
}

function findLatestLinearHitlMarker(
  activities: readonly LinearAgentActivityRecord[],
): LinearHitlMarkerPayload | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const body = activities[index]?.content.body;
    if (body === undefined) continue;
    const marker = decodeLinearHitlMarker(body);
    if (marker !== null) return marker;
  }
  return null;
}

function decodeLinearHitlMarker(body: string): LinearHitlMarkerPayload | null {
  const start = body.lastIndexOf(LINEAR_HITL_MARKER_PREFIX);
  if (start === -1) return null;
  const payloadStart = start + LINEAR_HITL_MARKER_PREFIX.length;
  const end = body.indexOf(LINEAR_HITL_MARKER_SUFFIX, payloadStart);
  if (end === -1) return null;

  try {
    const decoded = Buffer.from(body.slice(payloadStart, end), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isMarkerPayload(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isMarkerPayload(value: unknown): value is LinearHitlMarkerPayload {
  if (!value || typeof value !== "object" || !("requests" in value)) return false;
  const requests = (value as { readonly requests?: unknown }).requests;
  return Array.isArray(requests) && requests.every(isStoredRequest);
}

function isStoredRequest(value: unknown): value is LinearStoredInputRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as {
    readonly allowFreeform?: unknown;
    readonly display?: unknown;
    readonly options?: unknown;
    readonly prompt?: unknown;
    readonly requestId?: unknown;
  };
  if (typeof request.prompt !== "string" || typeof request.requestId !== "string") return false;
  if (request.allowFreeform !== undefined && typeof request.allowFreeform !== "boolean") {
    return false;
  }
  if (
    request.display !== undefined &&
    request.display !== "confirmation" &&
    request.display !== "select" &&
    request.display !== "text"
  ) {
    return false;
  }
  const options = request.options;
  return options === undefined || (Array.isArray(options) && options.every(isStoredOption));
}

function isStoredOption(value: unknown): value is InputOption {
  if (!value || typeof value !== "object") return false;
  const option = value as {
    readonly description?: unknown;
    readonly id?: unknown;
    readonly label?: unknown;
    readonly style?: unknown;
  };
  if (typeof option.id !== "string" || typeof option.label !== "string") return false;
  if (option.description !== undefined && typeof option.description !== "string") return false;
  return (
    option.style === undefined ||
    option.style === "primary" ||
    option.style === "danger" ||
    option.style === "default"
  );
}
