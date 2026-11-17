import { createHash } from "node:crypto";

import type { ContextReader } from "#context/key.js";
import { ContextKey } from "#context/key.js";
import type { AlsContext } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import type { JsonValue } from "#shared/json.js";
import { isNonEmptyString } from "#shared/guards.js";
import { REACTIONS_STATE_KEY, type Continuation } from "./continuation.js";

export interface Slot {
  readonly value: JsonValue;
  readonly digest: string;
  readonly since: number;
  readonly live?: true;
}

export interface DefinitionsState {
  readonly slots: Readonly<Record<string, Slot>>;
  readonly memos?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  readonly discarded?: readonly string[];
  readonly latest: Readonly<Record<string, number>>;
  readonly at?: string;
  readonly revision?: string;
  readonly intents?: readonly PendingIntent[];
  readonly continuation?: Continuation;
  readonly cancelledTurnId?: string;
  readonly cancelledBy?: string;
  readonly cancelledOpening?: { readonly by: string; readonly deliveryIds: readonly string[] };
}

export interface PendingIntent {
  readonly reactionId: string;
  readonly occurrence: string;
  readonly type: "cancel" | "fail";
  readonly reason?: string;
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

export const MEMOS_CAP = 4 * 1024 * 1024;

export function memoBytes(result: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(result));
}

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

export function discardedByDeployment(ctx: Pick<ContextReader, "get">, scope: string): boolean {
  return readDefinitionsState(ctx).discarded?.includes(scope) === true;
}

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

interface LiveEntry {
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

export function forgetSessionLive(sessionId: string): void {
  liveSessions.delete(sessionId);
}

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
