import type { AuthorizationChallenge } from "#harness/authorization.js";
import { resolveActiveAuthorizationChallenges } from "./sign-ins.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import { isObject } from "#shared/guards.js";

import type { ActiveApprovalCandidate, DurableApprovalState } from "./candidates.js";
import { parseRelay, type Relay } from "./relays.js";

// Storage stays in hitl/ to keep the rule 50 import seam around the request codecs.
// Sign-ins and relays use machine transitions; approval writes through candidates.ts remain
// direct, and checkpoint upgrades migrate legacy storage outside the machine.
// The module that owns the human-in-the-loop storage key: the requests the
// session holds, i.e. responders' approval candidates, the sign-ins it waits on, and the requests
// it relays for a workflow run or a child session. Nothing else names their session-state key;
// `candidates.ts` and `relays.ts` model the records it stores.

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
  /** Where answers go for the requests this session relays, by interaction id. */
  readonly relays: ReadonlyMap<string, Relay>;
}

/** Each record is parsed on first read: most readers want one. */
export function readHitlState(state: SessionStateMap | undefined): HitlState {
  let signIns: readonly AuthorizationChallenge[] | undefined;
  let relays: ReadonlyMap<string, Relay> | undefined;
  return {
    get signIns() {
      return (signIns ??= readSignIns(state));
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
  return state === session.state ? session : { ...session, state };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Every request the session holds sits under one key, a field per kind, so no kind's ids can
// collide with another's.
interface StoredRequests {
  readonly approvals?: unknown;
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
  let next: SessionStateMap | undefined = rest;
  next = writeRequests(next, "approvals", approvals);
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
// Approval candidates
// ---------------------------------------------------------------------------

/**
 * A candidate is an Approve unless it records Cancel: candidates persisted
 * before Cancel was authorized carry no decision, and their responder pressed
 * Approve.
 */
function readActiveCandidates(
  candidates: Readonly<Record<string, ActiveApprovalCandidate>>,
): Readonly<Record<string, ActiveApprovalCandidate>> {
  return Object.fromEntries(
    Object.entries(candidates).map(([candidateId, candidate]) => [
      candidateId,
      { ...candidate, decision: candidate.decision === "deny" ? "deny" : "approve" },
    ]),
  );
}

/** The approval records. Only `candidates.ts` calls it. */
export function readApprovalState(state: SessionStateMap | undefined): DurableApprovalState {
  const value = readRequests(state).approvals;
  if (typeof value !== "object" || value === null) {
    return {
      activeCandidates: {},
      candidateHistory: [],
      nextCandidateSequence: 0,
      settlements: {},
    };
  }
  const candidate = value as Partial<DurableApprovalState>;
  return {
    activeCandidates:
      typeof candidate.activeCandidates === "object" && candidate.activeCandidates !== null
        ? readActiveCandidates(candidate.activeCandidates)
        : {},
    candidateHistory: Array.isArray(candidate.candidateHistory) ? candidate.candidateHistory : [],
    nextCandidateSequence:
      typeof candidate.nextCandidateSequence === "number" &&
      Number.isSafeInteger(candidate.nextCandidateSequence) &&
      candidate.nextCandidateSequence >= 0
        ? candidate.nextCandidateSequence
        : deriveNextCandidateSequence(candidate),
    settlements:
      typeof candidate.settlements === "object" && candidate.settlements !== null
        ? candidate.settlements
        : {},
  };
}

function deriveNextCandidateSequence(state: Partial<DurableApprovalState>): number {
  return (
    Object.keys(state.activeCandidates ?? {}).length +
    (Array.isArray(state.candidateHistory) ? state.candidateHistory.length : 0)
  );
}

/** Saves the approval records. Only `candidates.ts` calls it. */
export function writeApprovalState(
  state: SessionStateMap | undefined,
  approvalState: DurableApprovalState,
): SessionStateMap {
  return writeRequests(state, "approvals", approvalState) ?? {};
}

/**
 * Drops what a cleared context owned: sign-in attempts and responders' approval progress. `clear`
 * reported each close; relay routes for live tasks stay.
 */
export function discardClearedHitlState<T extends HarnessSessionBase>(session: T): T {
  const state = writeRequests(writeSignIns(session.state, []), "approvals", undefined);
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
