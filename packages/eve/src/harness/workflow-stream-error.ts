import { isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const WORKFLOW_STREAM_WRITE_ERROR_PATTERN =
  /^Stream (write|close) failed: HTTP (\d+)(?: \(([^)]*)\))?/;

export function extractWorkflowStreamWriteErrorDetails(error: unknown): JsonObject | null {
  for (const message of causeChainMessages(error)) {
    const details = parseStreamErrorMessage(message);
    if (details !== null) {
      return details;
    }
  }
  return null;
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
