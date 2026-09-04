import type { InboxReplyTarget, ReplyTarget } from "#execution/inbox/types.js";

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
  if (value === null || typeof value !== "object") return undefined;
  const target = value as Partial<InboxReplyTarget>;
  if (
    target.kind !== "inbox" ||
    typeof target.requestId !== "string" ||
    target.requestId.length === 0 ||
    target.address === null ||
    typeof target.address !== "object" ||
    typeof target.address.token !== "string" ||
    target.address.token.length === 0 ||
    typeof target.address.ownerRunId !== "string" ||
    target.address.ownerRunId.length === 0
  )
    return undefined;
  return {
    kind: "inbox",
    requestId: target.requestId,
    address: { token: target.address.token, ownerRunId: target.address.ownerRunId },
  };
}
