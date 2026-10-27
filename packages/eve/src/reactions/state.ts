import { createHash } from "node:crypto";

import type { ContextReader } from "#context/key.js";
import { ContextKey } from "#context/key.js";
import type { AlsContext } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import type { JsonValue } from "#shared/json.js";
import { isNonEmptyString } from "#shared/guards.js";

// The session's reactions as they stand, in its checkpointed state, never on the stream: one slot
// per dynamic value with what's installed, memo results, and the commands hooks queued. Installed values that carry code live in an in-process
// cache beside it; a step without them evaluates the definition again, and its memos return what
// they kept.

/** One dynamic value as installed. */
export interface Slot {
  /** The value's JSON form: what readers of data kinds read. */
  readonly value: JsonValue;
  /** The digest of `value`, which equality compares. */
  readonly digest: string;
  /** The line after which the slot last changed. */
  readonly since: number;
  /** The value carries code, which a process that didn't build it builds by evaluating again. */
  readonly live?: true;
}

export interface ReactionsState {
  readonly slots: Readonly<Record<string, Slot>>;
  /**
   * Memo results, by memo scope (a definition, or a hook's handler) and key digest: the keys the
   * scope's latest evaluation used. Discarded when the session moves to another deployment.
   */
  readonly memos?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Memo scopes a deployment change discarded, until each succeeds again: for diagnostics. */
  readonly discarded?: readonly string[];
  /** For user-role instructions: the digest of the content each definition last added. */
  readonly appended?: Readonly<Record<string, string>>;
  /** The latest line of each event type, plus `"*"` for the latest fact. */
  readonly latest: Readonly<Record<string, number>>;
  /** When the latest commit was written, as ISO 8601: `ctx.now`. */
  readonly at?: string;
  /** The runtime revision the latest step ran; memos made under another are discarded. */
  readonly revision?: string;
  /** Commands hooks queued that the session hasn't acted on yet. */
  readonly intents?: readonly PendingIntent[];
  /** The turn a hook's cancel stopped: a cancel acts once on its turn. */
  readonly cancelledTurnId?: string;
}

/** A command a hook queued, waiting for the session to act on it. */
export interface PendingIntent {
  /** The hook that queued it. */
  readonly reactionId: string;
  /** The occurrence it acts for, for diagnostics. */
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

/** Updates the state in place of the context's current one. */
export function updateReactionsState(
  ctx: AlsContext,
  update: (state: ReactionsState) => ReactionsState,
): void {
  writeReactionsState(ctx, update(readReactionsState(ctx)));
}

/**
 * The most one scope's memos take, in UTF-8 bytes of the JSON map from key digest to result that
 * every step of the session carries in its checkpoint: a few results at the 1 MB per-result cap.
 */
export const MEMOS_CAP = 4 * 1024 * 1024;

export function memoBytes(result: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(result));
}

/** A scope's evaluation succeeded: it keeps the memos it used, and only those. */
export function keepMemos(
  ctx: AlsContext,
  scope: string,
  used: Readonly<Record<string, JsonValue>>,
): void {
  const state = readReactionsState(ctx);
  const kept = state.memos?.[scope];
  const discarded = state.discarded?.filter((id) => id !== scope);
  const rest = withDiscarded(state, discarded);
  if (kept === undefined && Object.keys(used).length === 0) {
    if (discarded?.length !== state.discarded?.length) writeReactionsState(ctx, rest);
    return;
  }
  const memos = { ...state.memos };
  if (Object.keys(used).length === 0) delete memos[scope];
  else memos[scope] = used;
  writeReactionsState(ctx, { ...rest, memos });
}

function withDiscarded(
  state: ReactionsState,
  discarded: readonly string[] | undefined,
): ReactionsState {
  const { discarded: _discarded, ...rest } = state;
  return discarded === undefined || discarded.length === 0 ? rest : { ...rest, discarded };
}

/** Whether a deployment change discarded `scope`'s memos and it hasn't succeeded since. */
export function discardedByDeployment(ctx: Pick<ContextReader, "get">, scope: string): boolean {
  return readReactionsState(ctx).discarded?.includes(scope) === true;
}

/**
 * A scope's evaluation failed: the memos that ran are still valid observations, so it keeps them
 * beside what it had. Failures in a row can't grow it past `MEMOS_CAP`: once they would, it keeps
 * only what it had, which what's installed was built from, and the new memos run again.
 */
export function mergeMemos(
  ctx: AlsContext,
  scope: string,
  used: Readonly<Record<string, JsonValue>>,
): void {
  if (Object.keys(used).length === 0) return;
  const state = readReactionsState(ctx);
  const merged = { ...state.memos?.[scope], ...used };
  if (memoBytes(merged) > MEMOS_CAP) return;
  writeReactionsState(ctx, { ...state, memos: { ...state.memos, [scope]: merged } });
}

/**
 * A slot's value in the shape its kind wrote. The kind checked it when it contributed, so the
 * session holds only values of that shape: each kind reads its own slots, never another's.
 */
export function slotValueOf<T>(value: JsonValue | null | undefined): T {
  return value as T;
}

/** A stable digest of a JSON value. */
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
// Live values: code a slot's JSON form can't carry, cached per process.
// ---------------------------------------------------------------------------

interface LiveEntry {
  /** The digest of the slot value it was built with. */
  readonly digest: string;
  readonly live: unknown;
}

const LIVE_GLOBAL_KEY = Symbol.for("eve.reactions.live");
const MAX_CACHED_SESSIONS = 1_024;
type LiveGlobal = typeof globalThis & {
  [LIVE_GLOBAL_KEY]?: Map<string, Map<string, LiveEntry>>;
};
const liveSessions = ((globalThis as LiveGlobal)[LIVE_GLOBAL_KEY] ??= new Map());

export function sessionIdOf(ctx: Pick<ContextReader, "get">): string {
  const id = ctx.get(SessionIdKey);
  if (!isNonEmptyString(id)) throw new Error("Reaction state requires a session ID.");
  return id;
}

function sessionLive(ctx: Pick<ContextReader, "get">): Map<string, LiveEntry> {
  const sessionId = sessionIdOf(ctx);
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

/** The slot's live value, when this process built it for the value the slot holds. */
export function readLive(
  ctx: Pick<ContextReader, "get">,
  id: string,
  slot: Slot,
): { readonly live: unknown } | undefined {
  const entry = sessionLive(ctx).get(id);
  if (entry === undefined || entry.digest !== slot.digest) return undefined;
  return { live: entry.live };
}

export function writeLive(
  ctx: Pick<ContextReader, "get">,
  id: string,
  slot: Slot,
  live: unknown,
): void {
  sessionLive(ctx).set(id, { digest: slot.digest, live });
}

export function clearLive(ctx: Pick<ContextReader, "get">, id: string): void {
  sessionLive(ctx).delete(id);
}

/** Drops a session's live values, as a fresh process wouldn't have them. */
export function forgetSessionLive(sessionId: string): void {
  liveSessions.delete(sessionId);
}

/**
 * The slots of one kind, in the order each was first written, with their live values where this
 * process has them.
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
      const live = slot.live === true ? readLive(ctx, id, slot) : undefined;
      return live === undefined ? { id, slot } : { id, live: live.live, slot };
    });
}

/**
 * Versions for the entries one slot offers: each entry's JSON form with the memo results its
 * definition was built from. A parked call compares its entry's version before it runs.
 */
export function entryVersions(
  ctx: Pick<ContextReader, "get">,
  id: string,
): (offered: JsonValue) => string {
  const memos = digestOf(readReactionsState(ctx).memos?.[id] ?? {});
  return (offered) => digestOf({ memos, offered });
}

export function readSlot(
  ctx: Pick<ContextReader, "get"> | undefined,
  id: string,
): Slot | undefined {
  return readReactionsState(ctx).slots[id];
}
