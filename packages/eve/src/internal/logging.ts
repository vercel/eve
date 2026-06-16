/**
 * Framework-internal structured logger.
 *
 * Not public API; authors should use their own logger or Vercel
 * observability primitives.
 */
import { type Span, SpanStatusCode, trace } from "#compiled/@opentelemetry/api/index.js";
import { getErrorMessage } from "#compiled/@ai-sdk/provider/index.js";
import { inspect } from "node:util";

import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const MAX_INSPECT_STRING_LENGTH = 8 * 1024;
const MAX_DETAIL_BYTES = 16 * 1024;
const INSPECT_DEPTH = 10;

/**
 * Severity level for a single log record.
 *
 * Exposed so the logger API is composable with future sinks that want
 * to filter or route by severity.
 */
type LogLevel = "debug" | "info" | "warn" | "error";

/** Numeric severity per level, gated against {@link resolveThreshold}. */
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Extra structured context attached to a log record.
 *
 * Values that are Errors are normalized through {@link formatError}
 * before rendering, so a caller can pass `{ error }` and the full
 * cause chain will flow through to the sink.
 */
type LogFields = Readonly<Record<string, unknown>>;

/**
 * One namespaced logger handle. Returned by {@link createLogger}.
 *
 * Every method accepts an optional {@link LogFields} record of extra
 * key/value pairs to attach to the rendered line. Callers that want to
 * associate related lines should pass the same `errorId` on each call.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Builds a logger bound to a stable namespace (e.g. `"slack.route"` or
 * `"harness.tool-loop"`). The namespace appears in every rendered line
 * and is threaded through to OTel span events so a single grep can
 * correlate structured logs with traces.
 */
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

/**
 * Logs any throwable at `error` severity with its full {@link formatError}
 * representation, and returns the correlated `errorId`.
 *
 * Prefer over `logger.error(message, { error })` at `catch` sites where the
 * caught value is `unknown`: it also normalizes non-`Error` throwables (e.g.
 * plain objects that crossed a workflow step boundary) that the bare logger
 * would otherwise emit without a `detail` dump.
 */
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

/**
 * Generates a stable, opaque identifier for one error instance.
 *
 * The same identifier should be included in every log line associated
 * with a given failure and in the user-visible error message so a
 * support ticket that quotes the id can be grepped back to a single
 * incident. Uses `crypto.randomUUID()` for uniqueness; callers should
 * not rely on the format beyond opacity.
 */
export function createErrorId(): string {
  return crypto.randomUUID();
}

/**
 * Normalizes an unknown throwable into a JSON-serializable summary.
 *
 * Pins `name` and `message` as first-class fields because OTel
 * conventions index them directly, and renders the full `util.inspect`
 * dump (cause chain included) into `detail` so upstream provider
 * `responseBody`, gateway `statusCode`, and any other enumerable
 * fields surface for log aggregators without per-subclass plumbing.
 *
 * Accepts either a raw throwable or an existing `{ errorId }` wrapper
 * so repeated logs can share one identifier.
 */
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

/**
 * Pulls a displayable `name` off a throwable. Real {@link Error}
 * instances contribute their `.name` (except the default `"Error"`
 * which adds no information beyond what `message` already carries);
 * plain-object shapes with a string `name` (e.g. errors that crossed
 * a workflow step boundary and lost their prototype) pass through too
 * so the downstream `code` derives from the original class name.
 */
function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name !== "Error" ? error.name : undefined;
  }
  if (isObject(error) && isNonEmptyString(error.name) && error.name !== "Error") {
    return error.name;
  }
  return undefined;
}

/**
 * Like `@ai-sdk/provider`'s `getErrorMessage` but prefers an explicit
 * `.message` property on plain-object throwables over JSON-stringifying
 * the whole shape. This keeps the rendered message human-readable
 * when an Error has been stripped to a plain object by structured
 * clone (workflow step boundary, postMessage, etc.).
 */
function extractErrorMessage(error: unknown): string {
  if (isObject(error) && !(error instanceof Error) && typeof error.message === "string") {
    return error.message;
  }
  return getErrorMessage(error);
}

/**
 * Pulls the correlated `errorId` off a `step.failed` / `turn.failed`
 * / `session.failed` event's `details` payload (or any other shape
 * produced by {@link formatError}). Returns `undefined` when the
 * sender did not attach one (older cascades, non-model-call error
 * paths that predate the shared format).
 *
 * The inverse-reader of {@link formatError}. Channels that surface
 * user-visible error text use it to embed a correlation id so a
 * support ticket quoting the id can be grepped back to one incident.
 */
export function extractErrorId(details: unknown): string | undefined {
  if (!isObject(details)) return undefined;
  return isNonEmptyString(details.errorId) ? details.errorId : undefined;
}

/**
 * Formats an "in parentheses" hint summarizing a failed-event payload
 * for user-visible display. Returns an empty string when neither the
 * structured error name nor message is useful.
 */
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

/**
 * Records an error on an OTel span and sets the span status to ERROR.
 *
 * Exposed for call sites that already have a span in hand (the harness
 * turn span). The logger itself also records on the *active* span when
 * `.error()` is called, so direct use is only necessary when a specific
 * non-active span should be annotated.
 */
export function recordErrorOnSpan(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : getErrorMessage(error);
  const name = error instanceof Error ? error.name : "Error";

  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.recordException({ message, name, stack: inspectError(error) });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Minimum severity to emit. `EVE_LOG_LEVEL` overrides; otherwise the default
 * is `info`, so `debug` is opt-in everywhere (it floods aggregators in prod
 * and the terminal in dev). Read per call so the env var can change without
 * rebuilding the logger.
 */
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

function write(level: LogLevel, namespace: string, message: string, fields?: LogFields): void {
  if (LEVEL_SEVERITY[level] < resolveThreshold()) {
    return;
  }
  // `debug` routes through `console.log` because most runtimes
  // default-silence `console.debug` and the aggregators we target
  // treat the stderr path (info/warn/error) as canonical. Look up
  // the sink per call so test spies installed on `console` take
  // effect even if the logger was constructed earlier.
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const line = `[eve:${namespace}] ${message}`;
  if (fields === undefined) {
    sink(line);
    return;
  }
  sink(line, renderFields(fields));
}

/**
 * Normalizes {@link LogFields} for structured rendering.
 *
 * Errors are replaced with their {@link formatError} representation so
 * the same shape that flows into event stream `details` also appears
 * in the log. Other values pass through unchanged.
 */
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
  if (error instanceof Error) {
    recordErrorOnSpan(span, error);
    return;
  }

  // `logError` passes a pre-formatted object, not a live `Error`; still
  // record it as a span exception so the trace keeps the `detail`.
  if (isFormattedError(error)) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException({
      message: error.message,
      name: typeof error.name === "string" ? error.name : "Error",
      stack: typeof error.detail === "string" ? error.detail : undefined,
    });
    return;
  }

  span.addEvent(message, fields ? (renderFields(fields) as Record<string, string>) : undefined);
}

/** Narrows to the shape produced by {@link formatError}. */
function isFormattedError(
  value: unknown,
): value is { message: string; name?: string; detail?: string } {
  return isObject(value) && typeof value.errorId === "string" && typeof value.message === "string";
}

function inspectError(error: unknown): string {
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
