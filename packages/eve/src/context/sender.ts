import type { SessionAuthContext } from "#channel/types.js";
import type { ContextReader } from "#context/key.js";
import { SenderAuthKey } from "#context/keys.js";

/** The turn's latest sender: the seed while someone other than its caller spoke last, else `current`. */
export function readSender(
  ctx: Pick<ContextReader, "get"> | undefined,
  current: SessionAuthContext | null,
): SessionAuthContext | null {
  const sender = ctx?.get(SenderAuthKey);
  return sender === undefined ? current : sender;
}
