import type { SessionView } from "#harness/session-machine/view.js";
import { approvalOf } from "./approval.js";
/**
 * The response-policy rules. An answer to an approval whose tool defines
 * `approval.response` doesn't answer it: it becomes a candidate, bound to the
 * person who sent it, and the runtime runs the policy before the answer is
 * committed (`policyChecks`), handing in what it did as a verdict.
 * The first candidate the policy allows settles the approval with its
 * decision, and every competing candidate goes stale. A rejected, failed, or
 * expired candidate leaves the approval open for another answer. A policy
 * that needs the responder to authorize keeps the candidate waiting on that authorization,
 * which belongs to it rather than opening a request of its own, and runs
 * again once it completes.
 *
 * Every candidate and settlement is kept in the session's audit, so a retry
 * gets a fresh candidate and a settled approval can't be settled again.
 */
import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { Command } from "#harness/hitl/command.js";
import type {
  Input,
  PolicyCheck,
  PolicyRun,
  RequestAt,
  CandidateDecision,
} from "#harness/hitl/input.js";
import type {
  Reduced,
  ActiveCandidate,
  ApprovalAudit,
  FinishedCandidate,
  OpenApproval,
  ResponderIdentity,
  Settlement,
} from "#harness/hitl/state.js";
import { EMPTY_AUDIT } from "#harness/hitl/state.js";
import { completed, authorizationRequested } from "#harness/hitl/authorization.js";
import {
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  createMessageCompletedEvent,
  type ApprovalCandidateOutcome,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

const CANDIDATE_TTL_MS = 10 * 60_000;
const UNAUTHENTICATED_FEEDBACK = "Authentication is required to respond to this approval.";
const FAILED_REASON = "We couldn’t verify your response. Please try again.";
const UNAVAILABLE_REASON = "Approval authorization is temporarily unavailable. Please try again.";
const EXPIRED_REASON = "The approval response expired. Please submit a new response.";
const SETTLED_REASON = "Another response settled this approval.";

/**
 * Answers to policy-gated approvals become candidates, each checked by its
 * policy. An answer without a decision, a repeat of an active candidate, or an
 * answer to an approval already settled changes nothing; an answer nobody
 * signed is refused, since the policy decides who may answer.
 */
export function proposeCandidates(
  state: SessionView,
  input: {
    readonly now: number;
    readonly responder: SessionAuthContext | null;
    readonly responses: readonly InputResponse[];
  },
): Reduced & { readonly checks: readonly PolicyCheck[] } {
  let next = state;
  const events: Command[] = [];
  const checks: PolicyCheck[] = [];
  for (const response of input.responses) {
    const approval = approvalOf(next, response.requestId);
    if (approval?.kind !== "tool-approval" || approval.answer !== undefined) continue;
    const decision = decisionOf(response.optionId);
    if (decision === undefined) continue;
    if (input.responder === null) {
      events.push({
        event: createMessageCompletedEvent({ message: UNAUTHENTICATED_FEEDBACK, ...approval.at }),
        type: "publish",
      });
      continue;
    }
    const responder = input.responder;
    const audit = auditOf(next);
    const repeated = Object.values(audit.activeCandidates).some(
      (candidate) =>
        candidate.requestId === response.requestId &&
        candidate.decision === decision &&
        sameResponder(candidate.responder, responder),
    );
    if (repeated) continue;
    const candidate: ActiveCandidate = {
      candidateId: candidateIdFor(audit, response.requestId, responder, decision),
      createdAt: input.now,
      decision,
      expiresAt: input.now + CANDIDATE_TTL_MS,
      requestId: response.requestId,
      responder,
      status: "pending",
    };
    next = withAudit(next, {
      ...audit,
      activeCandidates: { ...audit.activeCandidates, [candidate.candidateId]: candidate },
      nextCandidateSequence: audit.nextCandidateSequence + 1,
    });
    events.push(candidateEvent(approval.at, candidate, "pending"));
    checks.push(check(approval, candidate));
  }
  return { checks, events, state: next };
}

/**
 * The runtime ran a candidate's policy. Allowed settles the approval and
 * returns the answer it settled with, for the approval rules to apply. A
 * verdict for a candidate no longer active (expired, stale) changes nothing.
 */
export function checkedCandidate(
  state: SessionView,
  candidateId: string,
  ran: PolicyRun,
): Reduced & { readonly settled?: InputResponse } {
  const candidate = auditOf(state).activeCandidates[candidateId];
  const approval = candidate === undefined ? undefined : approvalOf(state, candidate.requestId);
  if (candidate === undefined || approval?.kind !== "tool-approval") return { events: [], state };
  const verdict = verdictOf(ran);
  switch (verdict.verdict) {
    case "allowed":
      return settle(state, approval, candidate);
    case "rejected":
      return finish(state, [candidate], "rejected", verdict.reason);
    case "failed":
      return finish(state, [candidate], "failed", verdict.reason ?? FAILED_REASON);
    case "authorization-required": {
      // Each authorization is the responder's and settles only this candidate.
      const authorizations = verdict.challenges.map((challenge) => ({
        ...challenge,
        candidateId: candidate.candidateId,
        requester: challenge.requester ?? candidate.responder,
      }));
      const waiting: ActiveCandidate = {
        ...candidate,
        authorizations,
        expiresAt: Math.min(candidate.expiresAt, ...authorizations.map(providerExpiry)),
        status: "authorization-required",
      };
      return {
        events: authorizations.map((challenge) => authorizationRequested(challenge, approval.at)),
        state: withCandidate(state, waiting),
      };
    }
  }
}

/**
 * When the provider stops accepting `challenge`'s callback. The candidate
 * waits no longer than that, and never longer than its own deadline.
 */
function providerExpiry(challenge: AuthorizationChallenge): number {
  const expiresAt = Date.parse(challenge.challenge.expiresAt ?? "");
  return Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
}

type Verdict =
  | { readonly verdict: "allowed" }
  | { readonly verdict: "rejected"; readonly reason?: string }
  | { readonly verdict: "failed"; readonly reason?: string }
  | {
      readonly verdict: "authorization-required";
      readonly challenges: readonly AuthorizationChallenge[];
    };

/**
 * A policy allows or rejects by what it returns. Anything else fails the
 * candidate, except a throw that asks the responder to authorize first.
 */
function verdictOf(ran: PolicyRun): Verdict {
  switch (ran.kind) {
    case "missing":
      return { reason: UNAVAILABLE_REASON, verdict: "failed" };
    case "returned":
      if (ran.value.status === "allowed") return { verdict: "allowed" };
      if (ran.value.status === "rejected") return { reason: ran.value.reason, verdict: "rejected" };
      return { verdict: "failed" };
    case "threw":
      return ran.challenges === undefined
        ? { verdict: "failed" }
        : { challenges: ran.challenges, verdict: "authorization-required" };
  }
}

/**
 * A callback arrived for a responder's authorization. Once authorized, its callback
 * goes to the policy, which runs again as soon as the candidate waits on no
 * other authorization: `checks` has it, with the callback for the policy to read.
 * A failed authorization fails the candidate. A callback for no candidate's authorization
 * returns `undefined`.
 */
export function completeCandidateAuthorization(
  state: SessionView,
  input: Extract<Input, { readonly type: "authorization.completed" }>,
): (Reduced & { readonly checks: readonly PolicyCheck[] }) | undefined {
  const candidate = Object.values(auditOf(state).activeCandidates).find((active) =>
    active.authorizations?.some((challenge) => opens(challenge, input)),
  );
  const approval = candidate === undefined ? undefined : approvalOf(state, candidate.requestId);
  if (candidate === undefined || approval?.kind !== "tool-approval") return undefined;
  const challenge = candidate.authorizations!.find((authorization) => opens(authorization, input))!;
  const events: Command[] = [completed(challenge, approval.at, input.outcome)];
  if (input.outcome === "failed") {
    const failed = finish(
      withCandidate(state, without(candidate, challenge)),
      [candidate],
      "failed",
      FAILED_REASON,
    );
    return { checks: [], events: [...events, ...failed.events], state: failed.state };
  }
  const authorization =
    input.callback === undefined
      ? undefined
      : {
          attemptId: input.attemptId,
          callback: input.callback,
          hookUrl: challenge.hookUrl,
          instanceId: challenge.instanceId,
          name: challenge.name,
          principal: challenge.principal,
          resume: challenge.resume,
        };
  const rest = without(candidate, challenge);
  if ((rest.authorizations?.length ?? 0) > 0) {
    // The policy runs once its other authorizations complete; this callback waits in the step for it.
    if (authorization !== undefined) {
      // The policy binds its responder itself; the turn's person stays who it runs as.
      events.push({ requester: null, result: authorization, type: "resumeAuthorization" });
    }
    return { checks: [], events, state: withCandidate(state, rest) };
  }
  const { authorizations: _done, ...ready } = rest;
  const pending: ActiveCandidate = { ...ready, status: "pending" };
  return {
    checks: [check(approval, pending, authorization)],
    events,
    state: withCandidate(state, pending),
  };
}

/** The attempt ids of the authorizations responders' candidates wait on. */
export function candidateAuthorizationAttempts(state: SessionView): readonly string[] {
  return Object.values(auditOf(state).activeCandidates).flatMap((candidate) =>
    (candidate.authorizations ?? []).flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
  );
}

function opens(
  challenge: AuthorizationChallenge,
  input: { readonly attemptId: string; readonly connectionName: string },
): boolean {
  return (
    (challenge.attemptId ?? challenge.candidateId ?? challenge.name) === input.attemptId &&
    challenge.name === input.connectionName
  );
}

function without(candidate: ActiveCandidate, challenge: AuthorizationChallenge): ActiveCandidate {
  return {
    ...candidate,
    authorizations: candidate.authorizations?.filter(
      (authorization) => authorization !== challenge,
    ),
  };
}

function withCandidate(state: SessionView, candidate: ActiveCandidate): SessionView {
  const audit = auditOf(state);
  return withAudit(state, {
    ...audit,
    activeCandidates: { ...audit.activeCandidates, [candidate.candidateId]: candidate },
  });
}

/** Candidates past their deadline time out, and their authorizations fail. */
export function expireCandidates(state: SessionView, now: number): Reduced {
  const expired = Object.values(auditOf(state).activeCandidates).filter(
    (candidate) => candidate.expiresAt <= now,
  );
  return finish(state, expired, "timed-out", undefined, {
    outcome: "failed",
    reason: EXPIRED_REASON,
  });
}

/**
 * The turn moved past its approvals, steered or cancelled: every active
 * candidate goes stale. Their authorizations close with the turn's other authorizations.
 */
export function staleCandidates(state: SessionView, reason: string): Reduced {
  return finish(state, Object.values(auditOf(state).activeCandidates), "stale", reason);
}

/** Settles the approval with the allowed candidate's decision; its competitors go stale. */
function settle(
  state: SessionView,
  approval: OpenApproval,
  winner: ActiveCandidate,
): Reduced & { readonly settled: InputResponse } {
  const competitors = Object.values(auditOf(state).activeCandidates).filter(
    (candidate) =>
      candidate.requestId === winner.requestId && candidate.candidateId !== winner.candidateId,
  );
  const stale = finish(state, competitors, "stale", SETTLED_REASON, {
    outcome: "declined",
    reason: SETTLED_REASON,
  });
  const allowed = finish(stale.state, [winner], "allowed");
  const audit = auditOf(allowed.state);
  const settlement: Settlement = {
    actor: identityOf(winner.responder),
    ...(winner.decision === "approve" && { approver: winner.responder }),
    candidateId: winner.candidateId,
    outcome: winner.decision === "approve" ? "allowed" : "cancelled",
    requestId: winner.requestId,
  };
  return {
    events: [
      ...stale.events,
      {
        event: createApprovalSettledEvent({
          outcome: winner.decision === "approve" ? "approved" : "cancelled",
          requestId: winner.requestId,
          responderPrincipalId: winner.responder.principalId,
          ...approval.at,
        }),
        type: "publish",
      },
    ],
    settled: { optionId: winner.decision, requestId: winner.requestId },
    state: withAudit(allowed.state, {
      ...audit,
      settlements: { ...audit.settlements, [winner.requestId]: settlement },
    }),
  };
}

/**
 * Moves candidates to the audit's history with `status`, reporting each but
 * an allowed one (its settlement reports it). The authorizations they still wait on
 * close with them: `authorizations` says how, declined with `reason` by default.
 */
function finish(
  state: SessionView,
  candidates: readonly ActiveCandidate[],
  status: FinishedCandidate["status"],
  reason?: string,
  authorizations: { readonly outcome: "declined" | "failed"; readonly reason?: string } = {
    outcome: "declined",
    reason,
  },
): Reduced {
  if (candidates.length === 0) return { events: [], state };
  const audit = auditOf(state);
  const activeCandidates = { ...audit.activeCandidates };
  const events: Command[] = [];
  const closed: Command[] = [];
  const finished: FinishedCandidate[] = [];
  for (const { candidateId } of candidates) {
    // The candidate as stored: what it still waits on.
    const candidate =
      activeCandidates[candidateId] ?? candidates.find((c) => c.candidateId === candidateId)!;
    delete activeCandidates[candidateId];
    const { responder, authorizations: waiting, status: _status, ...rest } = candidate;
    finished.push({
      ...rest,
      ...(reason !== undefined && { reason }),
      responder: identityOf(responder),
      status,
    });
    const approval = approvalOf(state, candidate.requestId);
    if (approval?.kind !== "tool-approval") continue;
    if (status !== "allowed") events.push(candidateEvent(approval.at, candidate, status, reason));
    for (const challenge of waiting ?? []) {
      closed.push(completed(challenge, approval.at, authorizations.outcome, authorizations.reason));
    }
  }
  return {
    events: [...closed, ...events],
    state: withAudit(state, {
      ...audit,
      activeCandidates,
      candidateHistory: [...audit.candidateHistory, ...finished],
    }),
  };
}

function check(
  approval: OpenApproval,
  candidate: ActiveCandidate,
  authorization?: PolicyCheck["authorization"],
): PolicyCheck {
  return {
    at: approval.at,
    ...(authorization !== undefined && { authorization }),
    candidateId: candidate.candidateId,
    decision: candidate.decision,
    request: approval.request,
    requester: approval.requester,
    responder: candidate.responder,
  };
}

function candidateEvent(
  at: RequestAt,
  candidate: ActiveCandidate,
  outcome: ApprovalCandidateOutcome,
  reason?: string,
): Command {
  return {
    event: createApprovalCandidateEvent({
      candidateId: candidate.candidateId,
      outcome,
      ...(reason !== undefined && { reason }),
      requestId: candidate.requestId,
      responderPrincipalId: candidate.responder.principalId,
      ...at,
    }),
    type: "publish",
  };
}

function decisionOf(optionId: string | undefined): CandidateDecision | undefined {
  if (optionId === "approve") return "approve";
  // ACP answers with "deny"; eve's own approval prompts offer "cancel".
  if (optionId === "cancel" || optionId === "deny") return "cancel";
  return undefined;
}

/**
 * One id per request, responder, and decision, so both an Approve and a
 * Cancel can be pending. A retry after a finished candidate gets a fresh id,
 * so its events never read as the earlier candidate's.
 */
function candidateIdFor(
  audit: ApprovalAudit,
  requestId: string,
  responder: SessionAuthContext,
  decision: CandidateDecision,
): string {
  const principal = [
    responder.authenticator,
    responder.issuer ?? "",
    responder.principalType,
    responder.principalId,
  ].join(":");
  const base = [requestId, principal, ...(decision === "approve" ? [] : [decision])]
    .map(encodeIdPart)
    .join(".");
  const used =
    audit.activeCandidates[base] !== undefined ||
    audit.candidateHistory.some((candidate) => candidate.candidateId === base);
  return used ? `${base}.${audit.nextCandidateSequence.toString(36)}` : base;
}

function encodeIdPart(value: string): string {
  return Array.from(value, (character) => character.codePointAt(0)!.toString(36)).join("-");
}

function sameResponder(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    left.issuer === right.issuer &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType
  );
}

function identityOf(responder: SessionAuthContext): ResponderIdentity {
  return {
    authenticator: responder.authenticator,
    ...(responder.issuer !== undefined && { issuer: responder.issuer }),
    principalId: responder.principalId,
    principalType: responder.principalType,
  };
}

function auditOf(state: SessionView): ApprovalAudit {
  return state.turn.hitl?.audit ?? EMPTY_AUDIT;
}

function withAudit(state: SessionView, audit: ApprovalAudit): SessionView {
  const before = new Set(
    Object.values(state.turn.hitl?.audit?.activeCandidates ?? {}).flatMap((candidate) =>
      (candidate.authorizations ?? []).map((challenge) => challenge.attemptId ?? challenge.name),
    ),
  );
  return {
    ...state,
    turn: { ...state.turn, hitl: { ...state.turn.hitl, audit } },
    signIns: [
      ...state.signIns.filter((challenge) => !before.has(challenge.attemptId ?? challenge.name)),
      ...Object.values(audit.activeCandidates).flatMap(
        (candidate) => candidate.authorizations ?? [],
      ),
    ],
  };
}

/** Pending candidates are policy work for the next durable step, not new answers. */
export function pendingPolicyChecks(state: SessionView): readonly PolicyCheck[] {
  return Object.values(auditOf(state).activeCandidates).flatMap((candidate) => {
    const approval = approvalOf(state, candidate.requestId);
    return candidate.status === "pending" && approval?.kind === "tool-approval"
      ? [check(approval, candidate)]
      : [];
  });
}
