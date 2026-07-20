import { isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { toError } from "#shared/errors.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";

const RESPONSE_BODY_SNIPPET_LIMIT = 1_000;
const API_ERROR_SUMMARY_LIMIT = 800;
const GATEWAY_MODEL_REQUEST_REJECTED_MESSAGE =
  "AI Gateway rejected the model request before the agent produced a response.";

/**
 * The upstream error name the AI Gateway uses for authentication failures.
 * Exported so consumers of `step.failed` details (the dev TUI's `/model`
 * hint) match the same identifier this module classifies on.
 */
export const GATEWAY_AUTHENTICATION_ERROR_NAME = "GatewayAuthenticationError";

/**
 * The summary `name` this module assigns to recognized gateway-auth
 * failures, carried into failure-event details. Exported for the same
 * consumers as {@link GATEWAY_AUTHENTICATION_ERROR_NAME}.
 */
export const GATEWAY_AUTH_FAILURE_SUMMARY_NAME = "AI Gateway authentication failed";

/**
 * Anchored regex for the upstream "unsupported tool" rejection message
 * that AI Gateway returns when a fallback provider cannot serve a
 * provider-specific tool (e.g. Bedrock rejecting `web_search_20250305`).
 *
 * The phrasing comes from the gateway's own provider attempt projection
 * and is stable across the Bedrock and Vertex Anthropic backends. We
 * anchor the match on the literal `tool type` prefix to avoid sweeping
 * in unrelated "not supported" errors.
 */
const UNSUPPORTED_TOOL_TYPE_REGEX = /tool type ['"]([\w.-]+)['"] is not supported/i;

/**
 * One human-readable summary of a known model-call configuration failure.
 *
 * Returned by {@link summarizeKnownModelCallConfigError} for terminal
 * failures that point at a fixable setup mistake (missing API key,
 * gateway auth failure). Surfaces actionable text in REPL output and in
 * structured `step.failed` events without dumping the full SDK error
 * inspection into user-facing logs.
 */
export interface ModelCallConfigErrorSummary {
  readonly name: string;
  readonly message: string;
}

interface ModelCallErrorSignals {
  readonly apiCallError: boolean;
  readonly apiErrorMessage?: string;
  readonly gatewayName?: string;
  readonly gatewayType?: string;
  readonly generationId?: string;
  readonly responseBodySnippet?: string;
  readonly statusCode?: number;
  readonly upstreamMessage?: string;
  readonly upstreamStatusCode?: number;
  readonly upstreamType?: string;
}

/**
 * Returns a concise actionable summary for known terminal configuration
 * errors raised during a model call. Returns `null` for everything else
 * so the caller falls back to the raw SDK message.
 */
export function summarizeKnownModelCallConfigError(
  error: unknown,
): ModelCallConfigErrorSummary | null {
  const rawName = readErrorName(error);
  const rawMessage = readErrorMessage(error);

  if (
    rawName === GATEWAY_AUTHENTICATION_ERROR_NAME ||
    /AI Gateway authentication/i.test(rawMessage)
  ) {
    // The upstream `GatewayAuthenticationError` builds one of three
    // contextual messages depending on which credential was offered
    // (api-key, oidc, neither). Surface a remediation that matches the
    // one that actually failed — collapsing all three into a single
    // "set AI_GATEWAY_API_KEY" hint misleads users whose shell already
    // exports a stale `AI_GATEWAY_API_KEY` that shadows the OIDC fallback.
    if (/Invalid API key/i.test(rawMessage)) {
      return {
        name: GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
        message:
          "AI Gateway rejected the provided API key. Update or unset `AI_GATEWAY_API_KEY` (check your shell profile if you did not set it for this project) — manage keys at https://vercel.com/dashboard/ai/api-keys. Unsetting it falls back to OIDC via `eve link`.",
      };
    }
    if (/Invalid OIDC token/i.test(rawMessage)) {
      return {
        name: GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
        message:
          "AI Gateway rejected the OIDC token. Run `eve link` to refresh `VERCEL_OIDC_TOKEN` in `.env.local`, or set `AI_GATEWAY_API_KEY` — create a key at https://vercel.com/dashboard/ai/api-keys.",
      };
    }
    return {
      name: GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
      message:
        "AI Gateway received no credentials. Run `eve link` to populate `VERCEL_OIDC_TOKEN`, or set `AI_GATEWAY_API_KEY` — create a key at https://vercel.com/dashboard/ai/api-keys.",
    };
  }

  if (rawName === "LoadAPIKeyError" || /API key is missing/i.test(rawMessage)) {
    return {
      name: "Model provider API key missing",
      message:
        "The model provider could not load an API key. Export the provider's API key environment variable (for example `AI_GATEWAY_API_KEY` or `OPENAI_API_KEY`) and try again.",
    };
  }

  return null;
}

/**
 * Returns a concise summary for known model-call request failures that are not
 * configuration errors. These failures happen before the agent can produce a
 * response, so the user-facing message should avoid implying a bad tool call.
 */
export function summarizeKnownModelCallRequestError(
  error: unknown,
): ModelCallConfigErrorSummary | null {
  // Known benign shape: skip the inspector dump and the stack (which would
  // point at the harness's own throw site, not upstream evidence).
  if (error instanceof EmptyModelResponseError) {
    return {
      name: "Empty model response",
      message: error.message,
    };
  }

  const signals = readModelCallErrorSignals(error);

  // Transient upstream failures (throttles, overloads) keep the generic
  // retry-exhausted framing; a summary here would read as a terminal
  // rejection and send users to debug their configuration.
  if (isTransientHttpStatus(signals.statusCode ?? signals.upstreamStatusCode)) {
    return null;
  }

  const apiSummary = signals.apiErrorMessage;
  if (apiSummary !== undefined) {
    return {
      name: isGatewayErrorSignal(signals)
        ? "AI Gateway model request rejected"
        : "Model provider API error",
      message: apiSummary,
    };
  }

  if (signals.statusCode === 400 && isGatewayErrorSignal(signals)) {
    return {
      name: "AI Gateway model request rejected",
      message: GATEWAY_MODEL_REQUEST_REJECTED_MESSAGE,
    };
  }

  const apiCallSummary = formatApiCallErrorFallback(signals);
  if (apiCallSummary !== undefined) {
    return {
      name: isGatewayErrorSignal(signals)
        ? "AI Gateway model request rejected"
        : "Model provider API error",
      message: apiCallSummary,
    };
  }

  return null;
}

function isTransientHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

/**
 * Returns the distinct upstream tool types referenced by any
 * "tool type 'X' is not supported" rejection in an AI Gateway error's
 * provider attempt list.
 *
 * Walks the cause chain to find the gateway error and inspects both the
 * structured `data` field and the raw `responseBody` JSON. Returns an
 * empty array for errors that are not of this shape.
 *
 * Used by the harness recovery path to identify which framework tools
 * to drop before retrying the failing step. Detection is by string
 * match on the upstream tool type — see
 * {@link resolveFrameworkToolFromUpstreamType} for the mapping back to
 * framework tool names.
 */
export function extractUnsupportedProviderToolTypes(error: unknown): readonly string[] {
  const found = new Set<string>();

  for (const candidate of walkCauseChain(error)) {
    collectUnsupportedToolTypesFromValue(readObjectField(candidate, "data"), found);

    const responseBody = readStringField(candidate, "responseBody");
    if (responseBody !== undefined) {
      try {
        collectUnsupportedToolTypesFromValue(JSON.parse(responseBody), found);
      } catch {
        // The response body may be truncated mid-JSON when the upstream
        // includes a large request snapshot. Fall back to a raw string
        // scan so we still surface the tool name when the regex match
        // lies before the truncation boundary.
        const match = UNSUPPORTED_TOOL_TYPE_REGEX.exec(responseBody);
        if (match?.[1] !== undefined) {
          found.add(match[1]);
        }
      }
    }
  }

  return [...found];
}

function collectUnsupportedToolTypesFromValue(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    const match = UNSUPPORTED_TOOL_TYPE_REGEX.exec(value);
    if (match?.[1] !== undefined) {
      out.add(match[1]);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectUnsupportedToolTypesFromValue(entry, out);
    }
    return;
  }

  if (isObject(value)) {
    for (const entry of Object.values(value)) {
      collectUnsupportedToolTypesFromValue(entry, out);
    }
  }
}

/**
 * Extracts compact, structured diagnostics from AI SDK / AI Gateway model-call
 * errors. The full SDK error can include very large request bodies (especially
 * tool schemas), so this shape lifts the important upstream response fields into
 * `step.failed.details` before any inspector output gets truncated.
 */
export function extractModelCallErrorDetails(error: unknown): JsonObject {
  const signals = readModelCallErrorSignals(error);
  const details: Record<string, JsonValue> = {};

  appendJsonField(details, "apiErrorMessage", signals.apiErrorMessage);
  appendJsonField(details, "gatewayName", signals.gatewayName);
  appendJsonField(details, "gatewayType", signals.gatewayType);
  appendJsonField(details, "statusCode", signals.statusCode);
  appendJsonField(details, "generationId", signals.generationId);
  appendJsonField(details, "upstreamStatusCode", signals.upstreamStatusCode);
  appendJsonField(details, "upstreamType", signals.upstreamType);
  appendJsonField(details, "upstreamMessage", signals.upstreamMessage);
  appendJsonField(details, "responseBodySnippet", signals.responseBodySnippet);

  return details;
}

function readErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }
  if (isObject(error) && typeof error.name === "string") {
    return error.name;
  }
  return undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return "";
}

/**
 * A model call that produced no content. Raised by tool-loop.ts from
 * either of its two triggers: `isEmptyModelResponse` (a completed step
 * with finishReason 'other' and no output — AI Gateway HTTP 200 whose
 * stream carries no content, no usage, and no error) or
 * {@link isNoOutputGeneratedError} (the AI SDK rejecting a stream that
 * closed after metadata without output, normalized via the model call's
 * rethrow so both shapes funnel into one recovery).
 *
 * The message is channel-visible when recovery is exhausted, so it is
 * written for end users. The SDK rejection is preserved as `cause` to
 * keep the two triggers distinguishable in logs.
 */
export class EmptyModelResponseError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The model did not return a response. Please try again.", options);
    this.name = "EmptyModelResponseError";
  }
}

/**
 * Coerces a streamed provider failure into an Error while retaining the raw
 * payload so provider discriminators remain visible to error classification.
 */
export function normalizeModelStreamError(raw: unknown): Error {
  const error = toError(raw);
  if (error === raw) return error;

  Object.defineProperty(error, "cause", {
    configurable: true,
    value: raw,
  });
  return error;
}

/**
 * True when the error (or any error in its cause chain) is the AI SDK's
 * `NoOutputGeneratedError`. Since `ai@7.0.0-canary.169` (vercel/ai#15938)
 * a model stream that ends after metadata without any output or finish
 * chunk rejects with this error instead of completing an empty step —
 * the same upstream failure `isEmptyModelResponse` detects, surfaced as
 * a throw. Matched by `name` rather than `instanceof` so the check
 * survives a duplicated `ai` package and `toError`'s plain-object
 * coercion, which preserves `name` but not class identity.
 */
export function isNoOutputGeneratedError(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (readErrorName(candidate) === "AI_NoOutputGeneratedError") {
      return true;
    }
  }
  return false;
}

/**
 * Classifies a model-call failure into the runtime's recovery policy.
 */
export function classifyModelCallError(error: unknown): "retry" | "recoverable" | "terminal" {
  if (isTurnCancellation(error)) {
    return "terminal";
  }

  // Not "retry": the empty response already resolved the step hooks'
  // one-shot stepResult promise, so a same-hooks retry would read the
  // stale empty result. The harness reissues with fresh hooks instead
  // (attemptEmptyResponseRecovery in tool-loop.ts).
  if (error instanceof EmptyModelResponseError) {
    return "recoverable";
  }

  // `APICallError` exposes `isRetryable`, populated by provider
  // adapters that already know what's transient on their side. We
  // read it via duck typing so the check survives a minor-version
  // bump of `@ai-sdk/provider`.
  if (hasRetryableFlag(error)) {
    return "retry";
  }

  if (summarizeKnownModelCallConfigError(error) !== null) {
    return "terminal";
  }

  const signals = readModelCallErrorSignals(error);
  if (isRetryableGatewayType(signals.gatewayType) || isRetryableGatewayType(signals.upstreamType)) {
    return "retry";
  }
  if (
    isTerminalGatewayType(signals.gatewayType) ||
    isTerminalGatewayType(signals.upstreamType) ||
    signals.gatewayName === "GatewayInvalidRequestError"
  ) {
    return "terminal";
  }

  const status = signals.statusCode;
  if (status !== undefined) {
    // 408/409/429 and 5xx are retryable server conditions. Non-retryable
    // 4xx responses usually point to a structural problem (invalid key,
    // context exceeded, malformed prompt) that repeating the same request
    // will not fix.
    if (status === 408 || status === 409 || status === 429 || status >= 500) return "retry";
    if (isAmbiguousGatewayInternalBadRequest(signals)) return "recoverable";
    if (status >= 400 && status < 500) return "terminal";
  }

  if (isLikelyNetworkError(error)) {
    return "retry";
  }

  return "recoverable";
}

function hasRetryableFlag(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (isObject(candidate) && candidate.isRetryable === true) {
      return true;
    }
  }
  return false;
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    return true;
  }
  if (error.cause !== undefined && error.cause !== error) {
    return isLikelyNetworkError(error.cause);
  }
  return false;
}

function readModelCallErrorSignals(error: unknown): ModelCallErrorSignals {
  const gatewayError = findGatewayError(error);
  const upstreamError = findUpstreamApiCallError(error);
  const responseBody = readStringField(upstreamError, "responseBody");
  const upstreamBody = readGatewayErrorBody(upstreamError);

  return {
    apiCallError: upstreamError !== undefined,
    apiErrorMessage:
      upstreamBody?.apiErrorMessage ??
      firstInformativeApiMessage([readErrorMessage(upstreamError)]),
    gatewayName: readErrorName(gatewayError),
    gatewayType: readStringField(gatewayError, "type"),
    generationId: readStringField(gatewayError, "generationId") ?? upstreamBody?.generationId,
    responseBodySnippet:
      responseBody === undefined
        ? undefined
        : truncateSnippet(responseBody, RESPONSE_BODY_SNIPPET_LIMIT),
    statusCode:
      readStatusCode(gatewayError) ?? readStatusCode(upstreamError) ?? findStatusCode(error),
    upstreamMessage: upstreamBody?.message,
    upstreamStatusCode: readStatusCode(upstreamError),
    upstreamType: upstreamBody?.type,
  };
}

function findGatewayError(error: unknown): unknown {
  for (const candidate of walkCauseChain(error)) {
    const name = readErrorName(candidate);
    const type = readStringField(candidate, "type");
    if (name?.startsWith("Gateway") || type?.endsWith("_error") || type === "rate_limit_exceeded") {
      return candidate;
    }
  }
  return undefined;
}

function findUpstreamApiCallError(error: unknown): unknown {
  for (const candidate of walkCauseChain(error)) {
    const name = readErrorName(candidate);
    if (
      name === "AI_APICallError" ||
      readStringField(candidate, "responseBody") !== undefined ||
      readObjectField(candidate, "data") !== undefined ||
      readObjectField(candidate, "requestBodyValues") !== undefined
    ) {
      return candidate;
    }
  }
  return undefined;
}

function readGatewayErrorBody(error: unknown):
  | {
      readonly apiErrorMessage?: string;
      readonly generationId?: string;
      readonly message?: string;
      readonly type?: string;
    }
  | undefined {
  const dataBody = readGatewayErrorBodyFromValue(readObjectField(error, "data"));
  if (dataBody !== undefined) {
    return dataBody;
  }

  const responseBody = readStringField(error, "responseBody");
  if (responseBody === undefined) {
    return undefined;
  }

  try {
    return readGatewayErrorBodyFromValue(JSON.parse(responseBody));
  } catch {
    return undefined;
  }
}

function readGatewayErrorBodyFromValue(value: unknown):
  | {
      readonly apiErrorMessage?: string;
      readonly generationId?: string;
      readonly message?: string;
      readonly type?: string;
    }
  | undefined {
  if (!isObject(value)) return undefined;
  const error = readObjectField(value, "error");
  const generationId = readStringField(value, "generationId");
  const message = readStringField(error, "message") ?? readStringField(value, "message");
  const type = readStringField(error, "type") ?? readStringField(value, "type");
  const apiErrorMessage = firstInformativeApiMessage([
    message,
    ...readNestedApiErrorMessages(error),
    ...readNestedApiErrorMessages(value),
  ]);
  return message === undefined &&
    type === undefined &&
    generationId === undefined &&
    apiErrorMessage === undefined
    ? undefined
    : { apiErrorMessage, generationId, message, type };
}

function readStatusCode(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function findStatusCode(error: unknown): number | undefined {
  for (const candidate of walkCauseChain(error)) {
    const statusCode = readStatusCode(candidate);
    if (statusCode !== undefined) {
      return statusCode;
    }
  }
  return undefined;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return isObject(field) ? field : undefined;
}

function readNestedApiErrorMessages(value: unknown): readonly string[] {
  if (!isObject(value)) return [];
  const messages: string[] = [];
  appendString(messages, readStringField(value, "message"));
  appendString(messages, readStringField(value, "error_description"));
  appendNestedApiFieldMessages(messages, value.error);
  // `code` can carry a structured rejection ({ message }) on OpenAI-shaped
  // bodies. `param` and `status` never hold prose - promoting them surfaced
  // bare field names ("input") as the user-facing error.
  appendNestedApiFieldMessages(messages, value.code);

  return messages;
}

function appendNestedApiFieldMessages(out: string[], value: unknown): void {
  if (typeof value === "string") {
    appendString(out, value);
    return;
  }
  if (!isObject(value)) return;
  appendString(out, readStringField(value, "message"));
  appendString(out, readStringField(value, "error"));
  appendString(out, readStringField(value, "description"));
  appendString(out, readStringField(value, "error_description"));
  appendNestedApiFieldMessages(out, value.error);
}

function appendString(out: string[], value: string | undefined): void {
  if (value !== undefined) out.push(value);
}

function firstInformativeApiMessage(messages: readonly (string | undefined)[]): string | undefined {
  for (const message of messages) {
    if (message !== undefined && isInformativeApiMessage(message)) {
      return truncateSnippet(message, API_ERROR_SUMMARY_LIMIT);
    }
  }
  return undefined;
}

function isInformativeApiMessage(message: string): boolean {
  const normalized = message.trim();
  return (
    normalized.length > 0 &&
    normalized !== "[object Object]" &&
    normalized !== "AI_APICallError" &&
    normalized !== "Bad Request" &&
    normalized !== "Internal Server Error"
  );
}

function formatApiCallErrorFallback(signals: ModelCallErrorSignals): string | undefined {
  if (!signals.apiCallError) return undefined;
  const status = signals.statusCode ?? signals.upstreamStatusCode;
  const body = signals.responseBodySnippet;
  const type =
    signals.upstreamType !== undefined && isInformativeApiMessage(signals.upstreamType)
      ? signals.upstreamType
      : undefined;
  if (status === undefined && body === undefined && type === undefined) {
    return undefined;
  }
  const qualifiers = [status === undefined ? undefined : `HTTP ${status}`, type]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const prefix =
    qualifiers.length === 0
      ? "Model provider API request failed"
      : `Model provider API request failed (${qualifiers})`;
  return body === undefined ? `${prefix}.` : `${prefix}: ${body}`;
}

function isRetryableGatewayType(type: string | undefined): boolean {
  return type === "overloaded_error" || type === "rate_limit_exceeded" || type === "timeout_error";
}

function isTerminalGatewayType(type: string | undefined): boolean {
  return (
    type === "authentication_error" ||
    type === "invalid_request_error" ||
    type === "model_not_found"
  );
}

function isGatewayErrorSignal(signals: ModelCallErrorSignals): boolean {
  return signals.gatewayName !== undefined || signals.gatewayType !== undefined;
}

function isAmbiguousGatewayInternalBadRequest(signals: ModelCallErrorSignals): boolean {
  return (
    signals.statusCode === 400 &&
    (signals.gatewayName === "GatewayInternalServerError" ||
      signals.gatewayType === "internal_server_error") &&
    (signals.upstreamType === undefined || signals.upstreamType === "internal_server_error")
  );
}

function* walkCauseChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

function appendJsonField(target: Record<string, JsonValue>, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function truncateSnippet(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}
