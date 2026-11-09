import type { ContextReader } from "#context/key.js";
import { ContextKey } from "#context/key.js";
import type { AlsContext } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import type { JsonValue } from "#shared/json.js";
import { isNonEmptyString } from "#shared/guards.js";
import { REACTIONS_STATE_KEY, type Continuation } from "./continuation.js";
import { sha256Base64Url } from "#shared/digest.js";
import { utf8ByteLength } from "#shared/bytes.js";

// What the session's definitions keep, in its checkpointed state, never on the stream: one slot
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

export interface DefinitionsState {
  readonly slots: Readonly<Record<string, Slot>>;
  /**
   * Memo results, by memo scope (a definition, or a hook's handler) and key digest: the keys the
   * scope's latest evaluation used. Discarded when the session moves to another deployment.
   */
  readonly memos?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Memo scopes a deployment change discarded, until each succeeds again: for diagnostics. */
  readonly discarded?: readonly string[];
  /** The latest line of each event type, plus `"*"` for the latest fact. */
  readonly latest: Readonly<Record<string, number>>;
  /** When the latest commit was written, as ISO 8601: `ctx.now`. */
  readonly at?: string;
  /** The runtime revision the latest step ran; memos made under another are discarded. */
  readonly revision?: string;
  /** Commands hooks queued for the running turn that the session hasn't acted on yet. */
  readonly intents?: readonly PendingIntent[];
  /** The continuation hooks queued for the turn that settled, until the session admits or drops it. */
  readonly continuation?: Continuation;
  /** The turn a hook's cancel stopped: a cancel acts once on its turn. */
  readonly cancelledTurnId?: string;
  /** The hook whose cancel stopped `cancelledTurnId`, which may continue the turn. */
  readonly cancelledBy?: string;
  /**
   * A hook that cancelled input before its turn opened, with the deliveries that commit admitted,
   * until the next turn starts: that turn is the one it cancelled only if one of them caused it.
   */
  readonly cancelledOpening?: { readonly by: string; readonly deliveryIds: readonly string[] };
}

/** A command a hook queued for the running turn, waiting for the session to act on it. */
export interface PendingIntent {
  /** The hook that queued it. */
  readonly reactionId: string;
  /** The occurrence it acts for, for diagnostics. */
  readonly occurrence: string;
  /** `fail` is eve's own: a hook failed during the turn, which fails at its next boundary. */
  readonly type: "cancel" | "fail";
  readonly reason?: string;
  /** For a cancel or failure, the turn running when the hook ran: never a later one. */
  readonly turnId?: string;
}

export const DefinitionsStateKey = new ContextKey<DefinitionsState>(REACTIONS_STATE_KEY);

const EMPTY_STATE: DefinitionsState = { latest: {}, slots: {} };

export function readDefinitionsState(ctx: Pick<ContextReader, "get">): DefinitionsState {
  return ctx.get(DefinitionsStateKey) ?? EMPTY_STATE;
}

export function writeDefinitionsState(ctx: AlsContext, state: DefinitionsState): void {
  ctx.set(DefinitionsStateKey, state);
}

/**
 * The most one scope's memos take, in UTF-8 bytes of the JSON map from key digest to result that
 * every step of the session carries in its checkpoint: a few results at the 1 MB per-result cap.
 */
export const MEMOS_CAP = 4 * 1024 * 1024;

export function memoBytes(result: JsonValue): number {
  return utf8ByteLength(JSON.stringify(result));
}

/** A scope's evaluation succeeded: it keeps the memos it used, and only those. */
export function keepMemos(
  ctx: AlsContext,
  scope: string,
  used: Readonly<Record<string, JsonValue>>,
): void {
  const state = readDefinitionsState(ctx);
  const kept = state.memos?.[scope];
  const discarded = state.discarded?.filter((id) => id !== scope);
  const rest = withDiscarded(state, discarded);
  if (kept === undefined && Object.keys(used).length === 0) {
    if (discarded?.length !== state.discarded?.length) writeDefinitionsState(ctx, rest);
    return;
  }
  const memos = { ...state.memos };
  if (Object.keys(used).length === 0) delete memos[scope];
  else memos[scope] = used;
  writeDefinitionsState(ctx, { ...rest, memos });
}

function withDiscarded(
  state: DefinitionsState,
  discarded: readonly string[] | undefined,
): DefinitionsState {
  const { discarded: _discarded, ...rest } = state;
  return discarded === undefined || discarded.length === 0 ? rest : { ...rest, discarded };
}

/** Whether a deployment change discarded `scope`'s memos and it hasn't succeeded since. */
export function discardedByDeployment(ctx: Pick<ContextReader, "get">, scope: string): boolean {
  return readDefinitionsState(ctx).discarded?.includes(scope) === true;
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
  const state = readDefinitionsState(ctx);
  const merged = { ...state.memos?.[scope], ...used };
  if (memoBytes(merged) > MEMOS_CAP) return;
  writeDefinitionsState(ctx, { ...state, memos: { ...state.memos, [scope]: merged } });
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
  return sha256Base64Url(canonicalJson(value)).slice(0, 22);
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
 * process has them. A model call reads what definitions contribute, never another's slot; this is
 * for what applies a kind to the process or sandbox, and for readers outside a model call, such as
 * a dispatch step that needs the subagent a session selected.
 */
export function slotsOf(
  ctx: Pick<ContextReader, "get">,
  kind: string,
): readonly { readonly id: string; readonly slot: Slot; readonly live?: unknown }[] {
  const prefix = `${kind}:`;
  return Object.entries(readDefinitionsState(ctx).slots)
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
  const memos = digestOf(readDefinitionsState(ctx).memos?.[id] ?? {});
  return (offered) => digestOf({ memos, offered });
}

export function readSlot(ctx: Pick<ContextReader, "get">, id: string): Slot | undefined {
  return readDefinitionsState(ctx).slots[id];
}
