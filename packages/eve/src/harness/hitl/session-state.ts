import type { AuthorizationChallenge } from "#harness/authorization.js";
import { withSignIns } from "./sign-ins.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";

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
export function discardClearedHumanInput<T extends HarnessSessionBase>(session: T): T {
  const { [HITL_STATE_KEYS.approvals]: _approvals, ...state } =
    clearPendingAuthorization(session.state) ?? {};
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

// ---------------------------------------------------------------------------
// Pending sign-ins
// ---------------------------------------------------------------------------

export interface PendingAuthorizationState {
  readonly challenges: readonly AuthorizationChallenge[];
}

export function setPendingAuthorization(
  sessionState: Record<string, unknown> | undefined,
  value: PendingAuthorizationState,
): Record<string, unknown> {
  return {
    ...sessionState,
    [HITL_STATE_KEYS.signIns]: {
      challenges: withSignIns(
        getPendingAuthorization(sessionState)?.challenges ?? [],
        value.challenges,
      ),
    },
  };
}

export function clearPendingAuthorization(
  sessionState: Record<string, unknown> | undefined,
  attemptIds?: readonly string[],
): Record<string, unknown> | undefined {
  if (sessionState === undefined || sessionState[HITL_STATE_KEYS.signIns] === undefined) {
    return sessionState;
  }

  if (attemptIds !== undefined) {
    if (attemptIds.length === 0) return sessionState;

    const pending = getPendingAuthorization(sessionState);
    if (pending !== undefined) {
      const completedAttemptIds = new Set(attemptIds);
      const challenges = pending.challenges.filter(
        (challenge) => !completedAttemptIds.has(authorizationAttemptKey(challenge)),
      );
      if (challenges.length > 0) {
        return {
          ...sessionState,
          [HITL_STATE_KEYS.signIns]: { challenges },
        };
      }
    }
  }

  const state = { ...sessionState };
  delete state[HITL_STATE_KEYS.signIns];
  return Object.keys(state).length > 0 ? state : undefined;
}

function authorizationAttemptKey(challenge: AuthorizationChallenge): string {
  return challenge.attemptId ?? challenge.candidateId ?? challenge.name;
}

export function getPendingAuthorization(
  sessionState: Record<string, unknown> | undefined,
): PendingAuthorizationState | undefined {
  if (!sessionState) return undefined;
  const v = sessionState[HITL_STATE_KEYS.signIns];
  if (typeof v !== "object" || v === null) return undefined;
  return v as PendingAuthorizationState;
}

// ---------------------------------------------------------------------------
// Relayed requests
// ---------------------------------------------------------------------------

/** `requestId → route` map stored on the parent session. */
type ProxyInputRequestMap = Readonly<Record<string, ProxyInputRequest>>;

/**
 * Returns the proxy-routing map as a fresh `Map`. Never returns a live
 * reference so accidental mutation cannot corrupt session state.
 */
export function getProxyInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, ProxyInputRequest> {
  return new Map(Object.entries(readMap(state)));
}

/**
 * Returns true when the session is currently proxying one or more
 * HITL requests on behalf of a descendant subagent.
 */
export function hasProxyInputRequests(state: SessionStateMap | undefined): boolean {
  for (const _ of Object.keys(readMap(state))) {
    return true;
  }
  return false;
}

/**
 * Replaces prior entries for the destination and input source with the provided
 * ones. A child raising a fresh batch overwrites its prior batch so the
 * parent never keeps stale request metadata. Other sources' routes stay
 * independently answerable.
 */
export function upsertProxyInputRequests<S extends HarnessSessionBase>(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly session: S;
}): S {
  return {
    ...input.session,
    state: upsertProxyInputRequestState({
      entries: input.entries,
      forChildContinuationToken: input.forChildContinuationToken,
      inputSource: input.inputSource,
      state: input.session.state,
    }),
  };
}

/** State-only variant for control-plane steps that already hold a durable projection. */
export function upsertProxyInputRequestState(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const next: Record<string, ProxyInputRequest> = {};

  for (const [requestId, route] of Object.entries(readMap(input.state))) {
    if (
      route.childContinuationToken !== input.forChildContinuationToken ||
      route.inputSource !== input.inputSource
    ) {
      next[requestId] = route;
    }
  }

  for (const [requestId, route] of input.entries) {
    next[requestId] = route;
  }

  const state = { ...input.state };
  if (Object.keys(next).length === 0) {
    delete state[HITL_STATE_KEYS.relays];
  } else {
    state[HITL_STATE_KEYS.relays] = next;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

/** Removes every proxy route the predicate selects. */
export function clearProxyInputRequestsWhere<T extends { readonly state?: SessionStateMap }>(
  session: T,
  select: (route: ProxyInputRequest, requestId: string) => boolean,
): T {
  const requestIds = Object.entries(readMap(session.state))
    .filter(([requestId, route]) => select(route, requestId))
    .map(([requestId]) => requestId);
  return retireProxyInputRequests(session, requestIds);
}

/** Removes only the request IDs whose responses were successfully forwarded. */
export function retireProxyInputRequests<T extends { readonly state?: SessionStateMap }>(
  session: T,
  requestIds: readonly string[],
): T {
  const current = readMap(session.state);
  const next = { ...current };
  let changed = false;

  for (const requestId of requestIds) {
    if (Object.hasOwn(next, requestId)) {
      delete next[requestId];
      changed = true;
    }
  }

  return changed ? writeMap(session, next) : session;
}

function readMap(state: SessionStateMap | undefined): ProxyInputRequestMap {
  const raw = state?.[HITL_STATE_KEYS.relays];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, ProxyInputRequest> = {};
  for (const [key, value] of Object.entries(raw)) {
    const request = parseProxyInputRequest(value, key);
    if (request !== undefined) {
      result[key] = request;
    }
  }
  return result;
}

function writeMap<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entries: Record<string, ProxyInputRequest>,
): T {
  const state = { ...session.state };

  if (Object.keys(entries).length === 0) {
    delete state[HITL_STATE_KEYS.relays];
    return {
      ...session,
      state: Object.keys(state).length > 0 ? state : undefined,
    };
  }

  state[HITL_STATE_KEYS.relays] = entries;
  return { ...session, state };
}
