/**
 * A2A identifiers over eve's durable ones, with no extra storage.
 *
 * - `contextId` is the eve session ID: one A2A context is one eve session.
 * - `taskId` names the delivery that started the task, plus its session. The task is the turn that
 *   delivery opened or joined (`DeliveryRow.turnId`).
 * - A message's delivery ID encodes its `messageId`, so history echoes the client's IDs.
 *
 * Both are opaque to clients. Neither is a capability: every read re-checks that the session
 * belongs to the authenticated caller (see `readOwnedInvocationRun`).
 */
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
  // Reject non-canonical encodings so one task has exactly one ID.
  return encodeTaskId({ deliveryId, sessionId }) === taskId ? { deliveryId, sessionId } : undefined;
}

const DELIVERY_PREFIX = "a2a_";

/**
 * The delivery ID a `messageId` delivers under: reversible, so history can echo it. A context is
 * one owner's session and A2A message IDs are unique per message, so within a session it names one
 * message, and a retry names the same delivery. The prefix keeps it apart from minted UUIDs.
 */
export function deliveryIdForMessage(messageId: string): string {
  return `${DELIVERY_PREFIX}${Buffer.from(messageId, "utf8").toString("base64url")}`;
}

/** The `messageId` an A2A delivery ID encodes; undefined for any other delivery. */
export function messageIdOfDelivery(deliveryId: string): string | undefined {
  if (!deliveryId.startsWith(DELIVERY_PREFIX)) return undefined;
  const encoded = deliveryId.slice(DELIVERY_PREFIX.length);
  const messageId = Buffer.from(encoded, "base64url").toString("utf8");
  return deliveryIdForMessage(messageId) === deliveryId ? messageId : undefined;
}

/**
 * The idempotency key a `messageId` delivers under. Scoped by owner so two callers that pick the
 * same `messageId` never collide, and prefixed so it can't overlap another channel's keys.
 */
export function messageIdempotencyKey(ownerKey: string, messageId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([ownerKey, messageId]), "utf8")
    .digest("base64url");
  return `a2a:${digest}`;
}

/** A `ListTasks` cursor: the sort key of the last task on the previous page, in its context. */
export function encodePageToken(contextId: string, at: number, seq: number): string {
  return Buffer.from(JSON.stringify([contextId, at, seq]), "utf8").toString("base64url");
}

/** The cursor a page token names, or `null` when it is malformed or from another context. */
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
  } catch {
    // Fall through: not a token this agent minted.
  }
  return null;
}
