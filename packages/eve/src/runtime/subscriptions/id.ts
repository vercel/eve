import { createHash } from "node:crypto";
import { canonicalJson } from "#definitions/state.js";

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
