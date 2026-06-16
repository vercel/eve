import { isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/**
 * Anchored on the workflow stream transport's own failure message. The
 * runtime's durable-stream HTTP sink throws `Error`s shaped like
 * `"Stream write failed: HTTP 504 (PUT https://…; x-vercel-id=…;
 * x-vercel-error=…): …"` (and the `close` variant) when a flush to the
 * workflow server fails. Matching the literal prefix keeps the predicate
 * narrow so genuine model-call errors — which never carry this
 * signature — are never reclassified.
 *
 * Group 1 is the operation (`write`/`close`), group 2 the HTTP status,
 * group 3 the parenthesized request context (the `PUT <url>` plus any
 * `x-vercel-*` headers the transport appended).
 */
const WORKFLOW_STREAM_WRITE_ERROR_PATTERN =
  /^Stream (write|close) failed: HTTP (\d+)(?: \(([^)]*)\))?/;

/**
 * Parses a durable event-stream write failure raised by the workflow
 * runtime's stream transport into structured diagnostics, or returns
 * `null` when `error` is not such a failure.
 *
 * The harness emits every runtime event by writing to the workflow's
 * durable `getWritable()` stream, and those writes are flushed to the
 * workflow server over HTTP. Because the stream is consumed inside the
 * harness's model-call try/catch, a failed flush (timeout, 5xx) would
 * otherwise be misattributed to the model. This lets the harness label
 * it as the workflow-infrastructure failure it is and attach the
 * failing endpoint + platform error code as evidence.
 *
 * The returned object carries `operation` (`"write"`/`"close"`) and,
 * when present in the message, `statusCode`, `url` (the `PUT` target),
 * `vercelId` (`x-vercel-id`), and `vercelError` (`x-vercel-error`, e.g.
 * `"FUNCTION_INVOCATION_TIMEOUT"`).
 *
 * Walks the cause chain so a wrapped transport error is still detected.
 */
export function extractWorkflowStreamWriteErrorDetails(error: unknown): JsonObject | null {
  for (const message of causeChainMessages(error)) {
    const details = parseStreamErrorMessage(message);
    if (details !== null) {
      return details;
    }
  }
  return null;
}

/**
 * Returns `true` when `error` is a durable event-stream write failure
 * raised by the workflow runtime's stream transport, not by the model
 * provider. Thin predicate over
 * {@link extractWorkflowStreamWriteErrorDetails}.
 */
export function isWorkflowStreamWriteError(error: unknown): boolean {
  return extractWorkflowStreamWriteErrorDetails(error) !== null;
}

function parseStreamErrorMessage(message: string): JsonObject | null {
  const match = WORKFLOW_STREAM_WRITE_ERROR_PATTERN.exec(message);
  if (match === null) {
    return null;
  }

  const statusCode = Number(match[2]);
  const details: Record<string, JsonValue> = { operation: match[1] ?? "" };

  if (Number.isFinite(statusCode)) {
    details.statusCode = statusCode;
  }

  for (const segment of (match[3] ?? "").split("; ")) {
    if (segment.startsWith("PUT ")) {
      details.url = segment.slice("PUT ".length);
    } else if (segment.startsWith("x-vercel-id=")) {
      details.vercelId = segment.slice("x-vercel-id=".length);
    } else if (segment.startsWith("x-vercel-error=")) {
      details.vercelError = segment.slice("x-vercel-error=".length);
    }
  }

  return details;
}

function* causeChainMessages(error: unknown): Generator<string> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      yield current.message;
      current = current.cause;
      continue;
    }
    if (isObject(current) && typeof current.message === "string") {
      yield current.message;
      current = current.cause;
      continue;
    }
    return;
  }
}
