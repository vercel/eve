import { type Span, SpanStatusCode, trace } from "#compiled/@opentelemetry/api/index.js";
import { getErrorMessage } from "#compiled/@ai-sdk/provider/index.js";
import { inspect } from "node:util";

import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { currentCapture } from "#compiled/@vercel/agent-runs/index.js";
import { truncateTelemetryText } from "#compiled/@vercel/agent-runs/otel.js";

const MAX_INSPECT_STRING_LENGTH = 8 * 1024;
const MAX_DETAIL_BYTES = 16 * 1024;
const INSPECT_DEPTH = 10;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(namespace: string): Logger {
  return {
    debug(message, fields) {
      write("debug", namespace, message, fields);
    },
    info(message, fields) {
      write("info", namespace, message, fields);
    },
    warn(message, fields) {
      write("warn", namespace, message, fields);
    },
    error(message, fields) {
      write("error", namespace, message, fields);
      recordOnActiveSpan(message, fields);
    },
  };
}

export function logError(
  logger: Logger,
  message: string,
  error: unknown,
  fields?: LogFields,
): string {
  const formatted = formatError(error);
  logger.error(message, { ...fields, error: formatted });
  return typeof formatted.errorId === "string" ? formatted.errorId : createErrorId();
}

export function createErrorId(): string {
  return crypto.randomUUID();
}

export function formatError(error: unknown, errorId?: string): JsonObject {
  const details: Record<string, JsonValue> = {
    errorId: errorId ?? createErrorId(),
    message: extractErrorMessage(error),
  };

  const name = extractErrorName(error);
  if (name !== undefined) {
    details.name = name;
  }

  details.detail = inspectError(error);

  return details;
}

function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name !== "Error" ? error.name : undefined;
  }
  if (isObject(error) && isNonEmptyString(error.name) && error.name !== "Error") {
    return error.name;
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (isObject(error) && !(error instanceof Error) && typeof error.message === "string") {
    return error.message;
  }
  return getErrorMessage(error);
}

export function formatErrorHint(event: {
  readonly message?: string;
  readonly details?: unknown;
}): string {
  const rawName = isObject(event.details) ? event.details.name : undefined;
  const name = isNonEmptyString(rawName) ? rawName : undefined;
  const message = typeof event.message === "string" ? event.message.trim() : "";

  if (name && message.length > 0) {
    return ` (${name}: ${truncateForDisplay(message)})`;
  }
  if (name) {
    return ` (${name})`;
  }
  if (message.length > 0) {
    return ` (${truncateForDisplay(message)})`;
  }
  return "";
}

function truncateForDisplay(value: string, maxChars = 160): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

export function recordErrorOnSpan(span: Span, error: unknown): void {
  if (currentCapture()?.recordOutputs === false) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    return;
  }
  const message = truncateTelemetryText(
    error instanceof Error ? error.message : getErrorMessage(error),
    4096,
  );
  const name = error instanceof Error ? truncateTelemetryText(error.name, 128) : "Error";

  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.recordException({ message, name, stack: inspectError(error) });
}

function resolveThreshold(): number {
  const configured = process.env.EVE_LOG_LEVEL?.toLowerCase();
  if (
    configured === "debug" ||
    configured === "info" ||
    configured === "warn" ||
    configured === "error"
  ) {
    return LEVEL_SEVERITY[configured];
  }
  return LEVEL_SEVERITY.info;
}

export function isLogLevelEnabled(level: LogLevel): boolean {
  return LEVEL_SEVERITY[level] >= resolveThreshold();
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly namespace: string;
  readonly message: string;
  readonly fields?: JsonObject;
}

let logRecordSubscriber: ((record: LogRecord) => void) | undefined;

export function setLogRecordSubscriber(
  subscriber: ((record: LogRecord) => void) | undefined,
): void {
  logRecordSubscriber = subscriber;
}

function write(level: LogLevel, namespace: string, message: string, fields?: LogFields): void {
  if (LEVEL_SEVERITY[level] < resolveThreshold()) {
    return;
  }
  const subscriber = logRecordSubscriber;
  if (subscriber !== undefined) {
    try {
      subscriber(
        fields === undefined
          ? { level, namespace, message }
          : { level, namespace, message, fields: renderFields(fields) },
      );
      return;
    } catch {}
  }
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const line = `[eve:${namespace}] ${message}`;
  if (fields === undefined) {
    sink(line);
    return;
  }
  sink(line, renderFields(fields));
}

function renderFields(fields: LogFields): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (value instanceof Error) {
      out[key] = formatError(value);
      continue;
    }
    out[key] = value as JsonValue;
  }
  return out;
}

function recordOnActiveSpan(message: string, fields?: LogFields): void {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return;
  }

  const error = fields?.error;
  if (currentCapture()?.recordOutputs === false) {
    if (error instanceof Error || isFormattedError(error)) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return;
  }
  if (error instanceof Error) {
    recordErrorOnSpan(span, error);
    return;
  }

  if (isFormattedError(error)) {
    const message = truncateTelemetryText(error.message, 4096);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    span.recordException({
      message,
      name: typeof error.name === "string" ? truncateTelemetryText(error.name, 128) : "Error",
      stack:
        typeof error.detail === "string" ? truncateTelemetryText(error.detail, 8192) : undefined,
    });
    return;
  }

  span.addEvent(message, fields ? (renderFields(fields) as Record<string, string>) : undefined);
}

function isFormattedError(
  value: unknown,
): value is { message: string; name?: string; detail?: string } {
  return isObject(value) && typeof value.errorId === "string" && typeof value.message === "string";
}

export function inspectError(error: unknown): string {
  return truncate(
    inspect(error, {
      breakLength: Number.POSITIVE_INFINITY,
      compact: false,
      depth: INSPECT_DEPTH,
      maxStringLength: MAX_INSPECT_STRING_LENGTH,
    }),
    MAX_DETAIL_BYTES,
  );
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let sliced = value.slice(0, maxBytes);
  while (Buffer.byteLength(sliced, "utf8") > maxBytes && sliced.length > 0) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}<…truncated>`;
}
