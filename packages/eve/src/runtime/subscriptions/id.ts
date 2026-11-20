import { createHash } from "node:crypto";
import { canonicalJson } from "#definitions/state.js";
import type { JsonObject } from "#shared/json.js";

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

export function channelEventKey(event: string, input: JsonObject): string {
  return createHash("sha256")
    .update(canonicalJson([event, input]))
    .digest("hex");
}
