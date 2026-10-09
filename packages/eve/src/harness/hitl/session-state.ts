import type { AuthorizationChallenge } from "#harness/authorization.js";
import { resolveActiveAuthorizationChallenges } from "./sign-ins.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import { isObject } from "#shared/guards.js";

import type { ActiveApprovalCandidate, DurableApprovalState } from "./candidates.js";
import { parseProxyInputRequest, type ProxyInputRequest } from "./relays.js";

// The only module that reads or writes human-in-the-loop session state: responders' approval
// candidates, the sign-ins the session waits on, and the requests it relays for a workflow run or
// a child session. Nothing else names `HITL_STATE_KEYS`; `candidates.ts` and `relays.ts` model
// the records it stores.

/** The session-state keys of the human-in-the-loop records. */
export const HITL_STATE_KEYS = {
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
  /** Requests this session relays for a child session or a workflow run, by `requestId`. */
  readonly relays: ReadonlyMap<string, ProxyInputRequest>;
}

/** Each record is parsed on first read: most readers want one. */
export function readHitlState(state: SessionStateMap | undefined): HitlState {
  let signIns: readonly AuthorizationChallenge[] | undefined;
  let relays: ReadonlyMap<string, ProxyInputRequest> | undefined;
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
  if (state?.[HITL_STATE_KEYS.signIns] !== undefined) return true;
  const relays = state?.[HITL_STATE_KEYS.relays];
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
  /** A child's fresh batch: it replaces the routes that child's input source held. */
  readonly upsert?: {
    readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
    readonly forChildContinuationToken: string;
    readonly inputSource?: string;
  };
  /** Routes whose answers went down to the asker, or whose request closed. */
  readonly retire?: readonly string[];
}

/** Writes a transition's change. Only the session machine's save calls it. */
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
      { ...candidate, decision: candidate.decision === "cancel" ? "cancel" : "approve" },
    ]),
  );
}

/** The approval records. Only `candidates.ts` calls it. */
export function readApprovalState(state: SessionStateMap | undefined): DurableApprovalState {
  const value = state?.[HITL_STATE_KEYS.approvals];
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
  return { ...state, [HITL_STATE_KEYS.approvals]: approvalState };
}

/**
 * Drops what a cleared context owned: sign-in attempts and responders' approval progress. `clear`
 * reported each close; relay routes for live tasks stay.
 */
export function discardClearedHitlState<T extends HarnessSessionBase>(session: T): T {
  const { [HITL_STATE_KEYS.approvals]: _approvals, ...state } =
    writeSignIns(session.state, []) ?? {};
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

// ---------------------------------------------------------------------------
// Pending sign-ins
// ---------------------------------------------------------------------------

function readSignIns(state: SessionStateMap | undefined): readonly AuthorizationChallenge[] {
  const value = state?.[HITL_STATE_KEYS.signIns];
  return isObject(value)
    ? ((value as { challenges?: readonly AuthorizationChallenge[] }).challenges ?? [])
    : [];
}

function writeSignIns(
  state: SessionStateMap | undefined,
  challenges: readonly AuthorizationChallenge[],
): SessionStateMap | undefined {
  if (state?.[HITL_STATE_KEYS.signIns] === undefined && challenges.length === 0) return state;
  const { [HITL_STATE_KEYS.signIns]: _signIns, ...rest } = state ?? {};
  if (challenges.length > 0) return { ...rest, [HITL_STATE_KEYS.signIns]: { challenges } };
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ---------------------------------------------------------------------------
// Relayed requests
// ---------------------------------------------------------------------------

function readRelays(
  state: SessionStateMap | undefined,
): Readonly<Record<string, ProxyInputRequest>> {
  const raw = state?.[HITL_STATE_KEYS.relays];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, ProxyInputRequest> = {};
  for (const [requestId, value] of Object.entries(raw)) {
    const request = parseProxyInputRequest(value, requestId);
    if (request !== undefined) result[requestId] = request;
  }
  return result;
}

function writeRelays(
  state: SessionStateMap | undefined,
  relays: Readonly<Record<string, ProxyInputRequest>>,
): SessionStateMap | undefined {
  const { [HITL_STATE_KEYS.relays]: _relays, ...rest } = state ?? {};
  if (Object.keys(relays).length > 0) return { ...rest, [HITL_STATE_KEYS.relays]: relays };
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * A child raising a fresh batch replaces the routes it held for that input source, so the parent
 * never keeps stale request metadata. Other sources' routes stay independently answerable.
 */
function upsertRelays(
  state: SessionStateMap | undefined,
  upsert: NonNullable<RelayChange["upsert"]>,
): SessionStateMap | undefined {
  const kept = Object.entries(readRelays(state)).filter(
    ([, route]) =>
      route.childContinuationToken !== upsert.forChildContinuationToken ||
      route.inputSource !== upsert.inputSource,
  );
  return writeRelays(state, Object.fromEntries([...kept, ...upsert.entries]));
}

function retireRelays(
  state: SessionStateMap | undefined,
  requestIds: readonly string[],
): SessionStateMap | undefined {
  const relays = readRelays(state);
  if (!requestIds.some((requestId) => Object.hasOwn(relays, requestId))) return state;
  return writeRelays(
    state,
    Object.fromEntries(
      Object.entries(relays).filter(([requestId]) => !requestIds.includes(requestId)),
    ),
  );
}
