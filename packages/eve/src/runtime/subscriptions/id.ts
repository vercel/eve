import { createHash } from "node:crypto";
import { canonicalJson } from "#definitions/state.js";
import type { JsonObject } from "#shared/json.js";

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

/** The key a channel's `emit` and a session's subscription meet on: one event and one input, compared exactly. */
export function channelEventKey(event: string, input: JsonObject): string {
  return createHash("sha256")
    .update(canonicalJson([event, input]))
    .digest("hex");
}
