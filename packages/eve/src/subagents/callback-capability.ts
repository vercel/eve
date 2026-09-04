import { isReplyTarget, type InboxReplyTarget, type ReplyTarget } from "#execution/inbox/types.js";

const PREFIX = "eve:callback:";
const MAX_TOKEN_BYTES = 4096;

/** The owner hook's opaque token is the bearer capability; the rest binds its destination. */
export function createCallbackCapability(target: ReplyTarget): string {
  if (target.kind !== "inbox")
    throw new Error("Remote agent callbacks require an invocation inbox.");
  const token = `${PREFIX}${Buffer.from(JSON.stringify(target)).toString("base64url")}`;
  if (token.length > MAX_TOKEN_BYTES)
    throw new Error("Callback capability exceeds its size limit.");
  return token;
}

export function readCallbackCapability(token: string): InboxReplyTarget | undefined {
  if (!token.startsWith(PREFIX) || token.length > MAX_TOKEN_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isReplyTarget(value) || value.kind !== "inbox") return undefined;
  return {
    kind: "inbox",
    requestId: value.requestId,
    address: { token: value.address.token, ownerRunId: value.address.ownerRunId },
  };
}
