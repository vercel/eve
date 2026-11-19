import { createHash } from "node:crypto";
import { canonicalJson } from "#definitions/state.js";
import type { JsonObject } from "#shared/json.js";

/** Identifies a subscription by its channel, event and normalized arguments. */
export function channelEventId(channelName: string, event: string, args: JsonObject): string {
  return createHash("sha256")
    .update(canonicalJson([channelName, event, args]))
    .digest("hex");
}
