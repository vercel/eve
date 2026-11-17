import { isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { toError, walkCauseChain } from "#shared/errors.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";

const RESPONSE_BODY_SNIPPET_LIMIT = 1_000;
const API_ERROR_SUMMARY_LIMIT = 800;
const GATEWAY_MODEL_REQUEST_REJECTED_MESSAGE =
  "AI Gateway rejected the model request before the agent produced a response.";

const UNSUPPORTED_PROVIDER_TOOL_MATCHERS: readonly ((text: string) => string | undefined)[] = [
  (text) => /tool type ['"]([\w.-]+)['"] is not supported/i.exec(text)?.[1],
  (text) => /Input tag ['"]([\w.-]+)['"] found using ['"]type['"] does not match/i.exec(text)?.[1],
  (text) => /Invalid value: ['"]([\w.-]+)['"]/i.exec(text)?.[1],
  (text) => (/web search is not supported for this request/i.test(text) ? "web_search" : undefined),
];

export interface UpstreamRejectionSummary {
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

export function extractUpstreamRejectionMessage(error: unknown): UpstreamRejectionSummary | null {
  const signals = readModelCallErrorSignals(error);

  if (isTransientHttpStatus(signals.statusCode ?? signals.upstreamStatusCode)) {
    return null;
  }

  const apiSummary = signals.apiErrorMessage;
  if (apiSummary !== undefined) {
    return { name: upstreamRejectionName(signals), message: apiSummary };
  }

  if (signals.statusCode === 400 && isGatewayErrorSignal(signals)) {
    return {
      name: "AI Gateway model request rejected",
      message: GATEWAY_MODEL_REQUEST_REJECTED_MESSAGE,
    };
  }

  const apiCallSummary = formatApiCallErrorFallback(signals);
  if (apiCallSummary !== undefined) {
    return { name: upstreamRejectionName(signals), message: apiCallSummary };
  }

  return null;
}

function upstreamRejectionName(signals: ModelCallErrorSignals): string {
  return isGatewayErrorSignal(signals)
    ? "AI Gateway model request rejected"
    : "Model provider API error";
}

function isTransientHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

export function extractUnsupportedProviderToolTypes(error: unknown): readonly string[] {
  const found = new Set<string>();

  for (const candidate of walkCauseChain(error)) {
    collectUnsupportedToolTypesFromValue(readObjectField(candidate, "data"), found);

    const responseBody = readStringField(candidate, "responseBody");
    if (responseBody !== undefined) {
      try {
        collectUnsupportedToolTypesFromValue(JSON.parse(responseBody), found);
      } catch {
        collectUnsupportedToolTypes(responseBody, found);
      }
    }
  }

  return [...found];
}

function collectUnsupportedToolTypes(text: string, out: Set<string>): void {
  for (const match of UNSUPPORTED_PROVIDER_TOOL_MATCHERS) {
    const type = match(text);
    if (type !== undefined) out.add(type);
  }
}

function collectUnsupportedToolTypesFromValue(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    collectUnsupportedToolTypes(value, out);
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

export function extractModelCallErrorDetails(error: unknown): JsonObject {
  const signals = readModelCallErrorSignals(error);
  const details: Record<string, JsonValue> = {};
  if (error instanceof ContentFilteredModelResponseError) {
    details.finishReason = "content-filter";
    appendJsonField(details, "generationId", error.generationId);
  }

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

export class EmptyModelResponseError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The model did not return a response. Please try again.", options);
    this.name = "EmptyModelResponseError";
  }
}

export class ModelStreamStalledError extends Error {
  readonly isRetryable = true;

  constructor(options: { cause: unknown }) {
    super("The model stopped responding. Please try again.", options);
    this.name = "ModelStreamStalledError";
  }
}

export class ContentFilteredModelResponseError extends Error {
  readonly generationId?: string;

  constructor(generationId?: string) {
    super("The model provider filtered this response.");
    this.name = "ContentFilteredModelResponseError";
    this.generationId = generationId;
  }
}

export function normalizeModelStreamError(raw: unknown): Error {
  const error = toError(raw);
  if (error === raw) return error;

  Object.defineProperty(error, "cause", {
    configurable: true,
    value: raw,
  });
  return error;
}

export function isNoOutputGeneratedError(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (readErrorName(candidate) === "AI_NoOutputGeneratedError") {
      return true;
    }
  }
  return false;
}

export function rejectsCredential(error: unknown): boolean {
  return readModelCallErrorSignals(error).statusCode === 401;
}

export function classifyModelCallError(error: unknown): "retry" | "recoverable" | "terminal" {
  if (isTurnCancellation(error)) {
    return "terminal";
  }

  if (error instanceof EmptyModelResponseError) {
    return "recoverable";
  }

  if (hasRetryableFlag(error)) {
    return "retry";
  }

  const summary = summarizeKnownError(error);
  if (summary?.tags.includes("recoverable") === true) {
    return "recoverable";
  }
  if (summary?.tags.includes("config") === true) {
    return "terminal";
  }
  if (summary?.tags.includes("transient") === true) {
    return "retry";
  }

  if (readErrorName(error) === "AI_TypeValidationError") {
    return "retry";
  }

  const signals = readModelCallErrorSignals(error);
  if (signals.statusCode === 402) {
    return "recoverable";
  }

  if (isRetryableGatewayType(signals.upstreamType)) {
    return "retry";
  }
  if (
    isTerminalGatewayType(signals.upstreamType) ||
    signals.gatewayType === "invalid_request_error" ||
    signals.gatewayName === "GatewayInvalidRequestError"
  ) {
    return "terminal";
  }

  const status = signals.statusCode;
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429 || status >= 500) return "retry";
    if (isAmbiguousGatewayInternalBadRequest(signals)) return "recoverable";
    if (status >= 400 && status < 500) return "terminal";
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
