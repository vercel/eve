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
// transitions write them; checkpoint upgrades migrate legacy storage outside the machine.

/** The session-state key of the human-in-the-loop requests. */
const REQUESTS_KEY = "eve.runtime.hitl.requests";

/** Where builds before checkpoint version 15 kept the requests. Only checkpoint upgrades read them. */
export const LEGACY_HITL_STATE_KEYS = {
  approvals: "eve.runtime.hitl.approvalState",
  signIns: "eve.runtime.pendingAuthorization",
  relays: "eve.runtime.proxyInputRequests",
} as const;

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

/** Responder records a transition writes or retires. */
export interface ResponderChange {
  readonly upsert?: Readonly<Record<string, PendingResponder>>;
  /** Responses that closed, or every record when `"all"`. */
  readonly retire?: readonly string[] | "all";
}

/** Relay routes a transition records or retires. */
export interface RelayChange {
  /** Routes of requests that opened, by interaction id. */
  readonly upsert?: Readonly<Record<string, Relay>>;
  /** Routes whose request closed. */
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

/**
 * Moves the records builds before checkpoint version 15 kept under
 * {@link LEGACY_HITL_STATE_KEYS} into the requests record as they were stored; each reader is as
 * lenient as its old one. Only the checkpoint upgrade calls it.
 */
export function upgradeLegacyHitlState(
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const {
    [LEGACY_HITL_STATE_KEYS.approvals]: approvals,
    [LEGACY_HITL_STATE_KEYS.signIns]: signIns,
    [LEGACY_HITL_STATE_KEYS.relays]: relays,
    ...rest
  } = state;
  // Responders' approval progress isn't carried forward: the answers it weighed are asked again.
  void approvals;
  let next: SessionStateMap | undefined = rest;
  next = writeRequests(
    next,
    "signIns",
    isObject(signIns) && signIns.challenges !== undefined ? signIns.challenges : signIns,
  );
  const noRelays = isObject(relays) && Object.keys(relays).length === 0;
  next = writeRequests(next, "relays", noRelays ? undefined : relays);
  return next ?? {};
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
  const retired =
    change.retire === "all"
      ? {}
      : Object.fromEntries(
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
