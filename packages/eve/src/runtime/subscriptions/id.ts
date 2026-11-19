import { createHash } from "node:crypto";
import { canonicalJson } from "#definitions/state.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/** A subscription is one session's hold on a key, so a session re-subscribing finds its own. */
export function channelSubscriptionId(input: {
  readonly channelName: string;
  readonly key: string;
  readonly sessionId: string;
  readonly executionPrincipal: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson([input.channelName, input.key, input.sessionId, input.executionPrincipal]),
    )
    .digest("hex");
}

/**
 * The key a channel's `emit` and a session's subscription meet on: one event and one input, with
 * string values compared without regard to case.
 */
export function channelEventKey(event: string, input: JsonObject): string {
  return createHash("sha256")
    .update(canonicalJson([event, foldCase(input)]))
    .digest("hex");
}

function foldCase(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(foldCase);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, foldCase(item)]));
  return value;
}
