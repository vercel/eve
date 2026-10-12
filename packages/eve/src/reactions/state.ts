import { createHash } from "node:crypto";

import type { ContextReader } from "#context/key.js";
import { ContextKey } from "#context/key.js";
import type { AlsContext } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import type { JsonValue } from "#shared/json.js";

// The session's reactions as they stand: one slot per reaction with its latest contribution, and
// the position of the latest event of each type, which selections read. Both ride the checkpoint
// and never reach the stream. Contributions that carry code live in an in-process cache beside
// it, and a step without them builds them from the JSON the slot recorded.

/** One reaction's current contribution. */
export interface Slot {
  /** Digest of the selection that produced it. */
  readonly digest: string;
  /** The contribution's JSON form: what readers of data kinds read, and what equality compares. */
  readonly value: JsonValue;
  /**
   * What `render` rendered the code from: `record`'s result, or the selection. Kept only when the
   * contribution carries code, so a step in another process can build it again.
   */
  readonly input?: JsonValue;
  /** The line after which the slot last changed. */
  readonly since: number;
  /** How many selections the reaction has had: each new selection is a new occurrence. */
  readonly occurrence?: number;
  /** The runtime revision that recorded it; another deployment evaluates it again. */
  readonly revision?: string;
  /** A render from the record didn't match what was offered: the next model call evaluates it. */
  readonly invalid?: true;
  /** Why a hook's occurrence failed. */
  readonly error?: string;
}

export interface ReactionsState {
  readonly slots: Readonly<Record<string, Slot>>;
  /** The latest line of each event type, plus `"*"` for the latest fact. */
  readonly latest: Readonly<Record<string, number>>;
  /** For user-role instructions: the occurrence of each slot already in the conversation. */
  readonly appended?: Readonly<Record<string, number>>;
  /** The runtime revision the latest turn step ran; a slot resolved under another is stale. */
  readonly revision?: string;
  /** Intents hooks returned that the session hasn't acted on yet, one per occurrence and type. */
  readonly intents?: readonly PendingIntent[];
}

/** An intent a hook returned for one occurrence, waiting for the session to act on it. */
export interface PendingIntent {
  /** The hook that returned it. */
  readonly reactionId: string;
  /** The occurrence it acts once for. */
  readonly occurrence: string;
  /** `fail` is eve's own: a hook failed during the turn, which fails at its next boundary. */
  readonly type: "cancel" | "compact" | "fail";
  readonly reason?: string;
  /** For a cancel or failure, the turn running when the hook ran: never a later one. */
  readonly turnId?: string;
}

export const ReactionsStateKey = new ContextKey<ReactionsState>("eve.reactions");

const EMPTY_STATE: ReactionsState = { latest: {}, slots: {} };

export function readReactionsState(ctx: Pick<ContextReader, "get"> | undefined): ReactionsState {
  return ctx?.get(ReactionsStateKey) ?? EMPTY_STATE;
}

export function writeReactionsState(ctx: AlsContext, state: ReactionsState): void {
  ctx.set(ReactionsStateKey, state);
}

/** A stable digest of a JSON selection. */
/**
 * A slot's value in the shape its kind wrote. The kind checked it when it contributed, so the
 * session holds only values of that shape: each kind reads its own slots, never another's.
 */
export function slotValueOf<T>(value: JsonValue | null | undefined): T {
  return value as T;
}

export function digestOf(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url").slice(0, 22);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(",")}}`;
}

// ---------------------------------------------------------------------------
// Live contributions: code a slot's JSON form can't carry, cached per process.
// ---------------------------------------------------------------------------

interface LiveEntry {
  readonly digest: string;
  readonly since: number;
  readonly live: unknown;
}

const LIVE_GLOBAL_KEY = Symbol.for("eve.reactions.live");
const MAX_CACHED_SESSIONS = 1_024;
type LiveGlobal = typeof globalThis & {
  [LIVE_GLOBAL_KEY]?: Map<string, Map<string, LiveEntry>>;
};
const liveSessions = ((globalThis as LiveGlobal)[LIVE_GLOBAL_KEY] ??= new Map());

function sessionLive(ctx: Pick<ContextReader, "get">): Map<string, LiveEntry> {
  const sessionId = ctx.get(SessionIdKey) ?? "";
  let entries = liveSessions.get(sessionId);
  if (entries === undefined) {
    entries = new Map();
    liveSessions.set(sessionId, entries);
    if (liveSessions.size > MAX_CACHED_SESSIONS) {
      liveSessions.delete(liveSessions.keys().next().value!);
    }
  } else {
    liveSessions.delete(sessionId);
    liveSessions.set(sessionId, entries);
  }
  return entries;
}

/** The slot's live contribution, when this process built it for the slot as it stands. */
export function readLive(
  ctx: Pick<ContextReader, "get">,
  id: string,
  slot: Slot,
): { readonly live: unknown } | undefined {
  const entry = sessionLive(ctx).get(id);
  if (entry === undefined || entry.digest !== slot.digest || entry.since !== slot.since) {
    return undefined;
  }
  return { live: entry.live };
}

export function writeLive(
  ctx: Pick<ContextReader, "get">,
  id: string,
  slot: Slot,
  live: unknown,
): void {
  sessionLive(ctx).set(id, { digest: slot.digest, live, since: slot.since });
}

export function clearLive(ctx: Pick<ContextReader, "get">, id: string): void {
  sessionLive(ctx).delete(id);
}

/** Drops a finished session's live contributions. */
export function forgetSessionLive(sessionId: string): void {
  liveSessions.delete(sessionId);
}

/**
 * The slots of one kind, in the order each was first written, with their live contributions where
 * this process has them.
 */
export function slotsOf(
  ctx: Pick<ContextReader, "get"> | undefined,
  kind: string,
): readonly { readonly id: string; readonly slot: Slot; readonly live?: unknown }[] {
  if (ctx === undefined) return [];
  const prefix = `${kind}:`;
  return Object.entries(readReactionsState(ctx).slots)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, slot]) => {
      const live = slot.invalid === true ? undefined : readLive(ctx, id, slot);
      return live === undefined ? { id, slot } : { id, live: live.live, slot };
    });
}

export function readSlot(
  ctx: Pick<ContextReader, "get"> | undefined,
  id: string,
): Slot | undefined {
  return readReactionsState(ctx).slots[id];
}
