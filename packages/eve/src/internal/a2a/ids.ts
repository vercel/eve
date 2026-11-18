import { createHash } from "node:crypto";

export interface TaskRef {
  readonly sessionId: string;
  readonly deliveryId: string;
}

const SEPARATOR = "\n";

export function encodeTaskId(ref: TaskRef): string {
  return Buffer.from(`${ref.sessionId}${SEPARATOR}${ref.deliveryId}`, "utf8").toString("base64url");
}

export function decodeTaskId(taskId: string): TaskRef | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(taskId, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const [sessionId, deliveryId, ...rest] = decoded.split(SEPARATOR);
  if (rest.length > 0 || !sessionId || !deliveryId) return undefined;
  return encodeTaskId({ deliveryId, sessionId }) === taskId ? { deliveryId, sessionId } : undefined;
}

const DELIVERY_PREFIX = "a2a_";

export function deliveryIdForMessage(messageId: string): string {
  return `${DELIVERY_PREFIX}${Buffer.from(messageId, "utf8").toString("base64url")}`;
}

export function messageIdOfDelivery(deliveryId: string): string | undefined {
  if (!deliveryId.startsWith(DELIVERY_PREFIX)) return undefined;
  const encoded = deliveryId.slice(DELIVERY_PREFIX.length);
  const messageId = Buffer.from(encoded, "base64url").toString("utf8");
  return deliveryIdForMessage(messageId) === deliveryId ? messageId : undefined;
}

export function messageIdempotencyKey(ownerKey: string, messageId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([ownerKey, messageId]), "utf8")
    .digest("base64url");
  return `a2a:${digest}`;
}

export function encodePageToken(contextId: string, at: number, seq: number): string {
  return Buffer.from(JSON.stringify([contextId, at, seq]), "utf8").toString("base64url");
}

export function decodePageToken(
  token: string,
  contextId: string,
): { readonly at: number; readonly seq: number } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === contextId &&
      Number.isSafeInteger(value[1]) &&
      Number.isSafeInteger(value[2])
    ) {
      return { at: value[1] as number, seq: value[2] as number };
    }
  } catch {}
  return null;
}
