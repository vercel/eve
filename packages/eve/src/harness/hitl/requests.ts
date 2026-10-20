import type { AuthorizationChallenge } from "#harness/authorization.js";
import { resolveActiveAuthorizationChallenges } from "./sign-ins.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import { isObject } from "#shared/guards.js";

import type { PendingResponder } from "./responders.js";
import { parseRelay, type Relay } from "./relays.js";

// The module that owns the human-in-the-loop storage key: the records the session holds while
// people act, i.e. who gave each answer a response policy weighs, the sign-ins it waits on, and
// the requests it relays for a workflow run or a child session. Nothing else names their
// session-state key; `responders.ts` and `relays.ts` model the records it stores. Machine
// transitions write them.

/** The session-state key of the human-in-the-loop requests. */
const REQUESTS_KEY = "eve.runtime.hitl.requests";

/**
 * A read-only snapshot of the human-in-the-loop records, the one way code outside `harness/hitl/`
 * reads them.
 */
export interface HitlState {
  /** The sign-in attempts the session waits on. */
  readonly signIns: readonly AuthorizationChallenge[];
  /** Who gave each answer a response policy still weighs, by response id. */
  readonly responders: Readonly<Record<string, PendingResponder>>;
  /** Where answers go for the requests this session relays, by interaction id. */
  readonly relays: ReadonlyMap<string, Relay>;
}

/** Each record is parsed on first read: most readers want one. */
export function readHitlState(state: SessionStateMap | undefined): HitlState {
  let signIns: readonly AuthorizationChallenge[] | undefined;
  let relays: ReadonlyMap<string, Relay> | undefined;
  let responders: Readonly<Record<string, PendingResponder>> | undefined;
  return {
    get signIns() {
      return (signIns ??= readSignIns(state));
    },
    get responders() {
      return (responders ??= readResponders(state));
    },
    get relays() {
      return (relays ??= new Map(Object.entries(readRelays(state))));
    },
  };
}

/**
 * Whether the session holds a sign-in or relayed request, or a record of them it can't read.
 * Settling the last one deletes its record; a malformed record that ordinary readers read as
 * empty must not let a session hand off.
 */
export function holdsHitlRequests(state: SessionStateMap | undefined): boolean {
  const requests = state?.[REQUESTS_KEY];
  if (requests === undefined) return false;
  if (!isObject(requests) || Array.isArray(requests)) return true;
  const { signIns, relays } = requests as StoredRequests;
  if (signIns !== undefined) return true;
  return relays !== undefined && (!isObject(relays) || Object.keys(relays).length > 0);
}

/** What a session-machine transition changes in these records. */
export interface HitlStateChange {
  /** Every sign-in the session waits on once the change applies; `[]` withdraws them all. */
  readonly signIns?: readonly AuthorizationChallenge[];
  readonly relays?: RelayChange;
  readonly responders?: ResponderChange;
}

/** Responder records a transition writes. Each retires once its response closes. */
export interface ResponderChange {
  readonly upsert?: Readonly<Record<string, PendingResponder>>;
  /** Responses whose record goes now: `dropClosedRecords` retires closed ones. */
  readonly retire?: readonly string[];
}

/** Relay routes a transition records. Each retires once its request closes or is answered. */
export interface RelayChange {
  /** Routes of requests that opened, by interaction id. */
  readonly upsert?: Readonly<Record<string, Relay>>;
  /** Routes whose record goes now: `dropClosedRecords` retires closed ones. */
  readonly retire?: readonly string[];
}

/** Writes a transition's change. Production callers are the machine save and its closed-route cleanup. */
export function writeHitlState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  change: HitlStateChange,
): T {
  let state = session.state;
  if (change.signIns !== undefined) {
    state = writeSignIns(state, resolveActiveAuthorizationChallenges(change.signIns));
  }
  if (change.relays?.upsert !== undefined) state = upsertRelays(state, change.relays.upsert);
  if (change.relays?.retire !== undefined) state = retireRelays(state, change.relays.retire);
  if (change.responders !== undefined) state = changeResponders(state, change.responders);
  return state === session.state ? session : { ...session, state };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Every request the session holds sits under one key, a field per kind, so no kind's ids can
// collide with another's.
interface StoredRequests {
  /** Who gave each answer a response policy still weighs, by response id. */
  readonly responders?: unknown;
  /** The sign-in attempts the session waits on. */
  readonly signIns?: unknown;
  /** Workflow runs' `ctx.ask()` questions and child sessions' requests, by request id. */
  readonly relays?: unknown;
}

function readRequests(state: SessionStateMap | undefined): StoredRequests {
  const requests = state?.[REQUESTS_KEY];
  return isObject(requests) ? requests : {};
}

/** Sets one kind's record; `undefined` drops it, and the key once no kind is left. */
function writeRequests(
  state: SessionStateMap | undefined,
  kind: keyof StoredRequests,
  value: unknown,
): SessionStateMap | undefined {
  const { [kind]: current, ...others } = readRequests(state);
  if (current === undefined && value === undefined) return state;
  const requests = value === undefined ? others : { ...others, [kind]: value };
  const { [REQUESTS_KEY]: _requests, ...rest } = state ?? {};
  if (Object.keys(requests).length > 0) return { ...rest, [REQUESTS_KEY]: requests };
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ---------------------------------------------------------------------------
// Responders
// ---------------------------------------------------------------------------

function readResponders(
  state: SessionStateMap | undefined,
): Readonly<Record<string, PendingResponder>> {
  const value = readRequests(state).responders;
  return isObject(value) && !Array.isArray(value)
    ? (value as Record<string, PendingResponder>)
    : {};
}

function changeResponders(
  state: SessionStateMap | undefined,
  change: ResponderChange,
): SessionStateMap | undefined {
  const current = readResponders(state);
  const retired = Object.fromEntries(
    Object.entries(current).filter(([id]) => !(change.retire ?? []).includes(id)),
  );
  const next = { ...retired, ...change.upsert };
  return writeRequests(state, "responders", Object.keys(next).length > 0 ? next : undefined);
}

/**
 * Drops what a cleared context owned: sign-in attempts and the responders policies weigh. `clear`
 * reported each close; relay routes for live tasks stay.
 */
export function discardClearedHitlState<T extends HarnessSessionBase>(session: T): T {
  const state = writeRequests(writeSignIns(session.state, []), "responders", undefined);
  return { ...session, state };
}

// ---------------------------------------------------------------------------
// Pending sign-ins
// ---------------------------------------------------------------------------

function readSignIns(state: SessionStateMap | undefined): readonly AuthorizationChallenge[] {
  const value = readRequests(state).signIns;
  return Array.isArray(value) ? value : [];
}

function writeSignIns(
  state: SessionStateMap | undefined,
  challenges: readonly AuthorizationChallenge[],
): SessionStateMap | undefined {
  return writeRequests(state, "signIns", challenges.length > 0 ? challenges : undefined);
}

// ---------------------------------------------------------------------------
// Relayed requests
// ---------------------------------------------------------------------------

function readRelays(state: SessionStateMap | undefined): Readonly<Record<string, Relay>> {
  const raw = readRequests(state).relays;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, Relay> = {};
  for (const [interactionId, value] of Object.entries(raw)) {
    const relay = parseRelay(value);
    if (relay !== undefined) result[interactionId] = relay;
  }
  return result;
}

function writeRelays(
  state: SessionStateMap | undefined,
  relays: Readonly<Record<string, Relay>>,
): SessionStateMap | undefined {
  return writeRequests(state, "relays", Object.keys(relays).length > 0 ? relays : undefined);
}

function upsertRelays(
  state: SessionStateMap | undefined,
  upsert: Readonly<Record<string, Relay>>,
): SessionStateMap | undefined {
  return writeRelays(state, { ...readRelays(state), ...upsert });
}

function retireRelays(
  state: SessionStateMap | undefined,
  interactionIds: readonly string[],
): SessionStateMap | undefined {
  const relays = readRelays(state);
  if (!interactionIds.some((id) => Object.hasOwn(relays, id))) return state;
  return writeRelays(
    state,
    Object.fromEntries(Object.entries(relays).filter(([id]) => !interactionIds.includes(id))),
  );
}
