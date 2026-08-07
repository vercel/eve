import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  cancelApprovalRequest,
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getActiveApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
  type ActiveApprovalCandidate,
} from "#harness/approval-candidates.js";
import {
  clearPendingAuthorization,
  getAuthorizationResult,
  getPendingAuthorization,
  isAuthorizationSignal,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  getPendingInputBatch,
  getResponseAuthRequiredRequestIds,
  normalizePendingInputResponses,
} from "#harness/input-requests.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
import type { InputRequest } from "#runtime/input/types.js";

const UNAUTHENTICATED_APPROVAL_FEEDBACK = "Authentication is required to respond to this approval.";
const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

export interface ApprovalDeliveryResult {
  readonly challenges: readonly AuthorizationChallenge[];
  readonly feedback: readonly string[];
  readonly kind:
    | "continue"
    | "continue-coordination"
    | "policy-work-required"
    | "authorization-required";
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}

/**
 * Advances approval state by one durable phase.
 *
 * | State | Input | Transition |
 * | --- | --- | --- |
 * | pending request | Approve | create responder-bound candidate |
 * | pending request | Cancel | settle cancelled and stale candidates |
 * | pending candidate | coordinator pass | run current authorizer |
 * | pending candidate | allowed | settle approved and stale competitors |
 * | pending candidate | rejected/error/expiry | append terminal history |
 * | pending candidate | authorization required | persist private challenge |
 * | authorization required | matching callback | re-run current authorizer |
 * | settled request | any later response | no state change |
 *
 * Delivery ingestion returns before authorizer work so Cancel and candidate
 * creation commit before long-running policy execution. Candidate results also
 * commit before lifecycle events are projected by the next stack layer.
 */
export async function coordinateApprovalDelivery(input: {
  readonly now?: number;
  readonly runtimeRevision?: string;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools?: HarnessToolMap;
}): Promise<ApprovalDeliveryResult> {
  const now = input.now ?? Date.now();
  const expiredChallengeNames = getApprovalAuditState(input.session.state)
    .activeCandidates.filter((candidate) => candidate.expiresAt <= now)
    .flatMap(
      (candidate) => candidate.authorizationChallenges?.map((challenge) => challenge.name) ?? [],
    );
  const expiredState = expireApprovalCandidates({ now, state: input.session.state });
  let session: HarnessSession = {
    ...input.session,
    state: clearPendingAuthorization(expiredState, expiredChallengeNames),
  };
  const batch = getPendingInputBatch(session.state);
  if (batch === undefined) return deliveryResult(session, input.stepInput);

  const stepInput = normalizePendingInputResponses({
    state: session.state,
    stepInput: input.stepInput,
  });
  const authorizationRequiredRequestIds = getResponseAuthRequiredRequestIds(session.state);
  const requests = new Map(batch.requests.map((request) => [request.requestId, request]));
  const challenges: AuthorizationChallenge[] = [];
  const feedback: string[] = [];
  const consumed = new Set<string>();
  let didCommit = false;
  const candidatesAtStart = getApprovalAuditState(session.state).activeCandidates;

  const deliveredResponses = [
    ...(stepInput?.attributedInputResponses ?? []),
    ...(stepInput?.inputResponses ?? []).map((response) => ({ auth: undefined, response })),
  ];
  for (const { auth: attributedResponder, response } of deliveredResponses) {
    const request = requests.get(response.requestId);
    if (request === undefined || !isApprovalRequest(request)) continue;

    const requiresAuthorization = authorizationRequiredRequestIds.has(response.requestId);
    if (!requiresAuthorization) {
      const context = contextStorage.getStore();
      const responder =
        attributedResponder !== undefined
          ? attributedResponder
          : (context?.get(AuthKey) ?? context?.get(SessionKey)?.auth.current ?? null);
      if (
        responder !== null &&
        (response.optionId === "approve" || response.optionId === "cancel")
      ) {
        consumed.add(response.requestId);
        const settled = settleDirectApprovalResponse({
          actor: responder,
          outcome: response.optionId === "approve" ? "allowed" : "cancelled",
          requestId: response.requestId,
          settledAt: now,
          state: session.state,
        });
        session = { ...session, state: settled.state };
        didCommit ||= settled.result.kind === "settled";
      }
      continue;
    }
    consumed.add(response.requestId);

    if (response.optionId === "cancel") {
      const responder =
        attributedResponder !== undefined
          ? attributedResponder
          : buildCallbackContext().session.auth.current;
      if (responder === null) {
        feedback.push(UNAUTHENTICATED_APPROVAL_FEEDBACK);
        continue;
      }
      const settled = cancelApprovalRequest({
        actor: responder,
        requestId: response.requestId,
        settledAt: now,
        state: session.state,
      });
      session = { ...session, state: settled.state };
      didCommit ||= settled.result.kind === "settled";
      continue;
    }

    if (response.optionId !== "approve") continue;
    const responder =
      attributedResponder !== undefined
        ? attributedResponder
        : buildCallbackContext().session.auth.current;
    if (responder === null) {
      feedback.push(UNAUTHENTICATED_APPROVAL_FEEDBACK);
      continue;
    }

    const created = createApprovalCandidate({
      candidateIdPrefix: approvalCandidateIdPrefix(request.requestId, responder),
      createdAt: now,
      expiresAt: now + APPROVAL_CANDIDATE_TTL_MS,
      requestId: request.requestId,
      responder,
      runtimeRevision: input.runtimeRevision,
      state: session.state,
    });
    session = { ...session, state: created.state };
    didCommit ||= created.result.kind === "created";
  }

  const remainingStepInput = removeConsumedResponses(stepInput, consumed);
  if (consumed.size > 0) {
    return deliveryResult(
      session,
      remainingStepInput,
      didCommit ? "continue-coordination" : "continue",
      [],
      feedback,
    );
  }

  // Candidates are persisted in an earlier pass. Run pending candidates and
  // resume only authorization-required candidates whose callback arrived.
  if (candidatesAtStart.some(candidateReadyForPolicyWork) && input.tools === undefined) {
    return deliveryResult(session, remainingStepInput, "policy-work-required");
  }

  const parkedChallengeNames = new Set(
    getPendingAuthorization(session.state)?.challenges.map((challenge) => challenge.name) ?? [],
  );
  for (const candidate of candidatesAtStart) {
    if (candidate.status === "authorization-required") {
      const candidateChallenges = candidate.authorizationChallenges ?? [];
      const hasCallback = candidateChallenges.some(
        (challenge) => getAuthorizationResult(challenge.name) !== undefined,
      );
      if (!hasCallback) {
        challenges.push(
          ...candidateChallenges.filter((challenge) => !parkedChallengeNames.has(challenge.name)),
        );
        continue;
      }
    }

    const request = requests.get(candidate.requestId);
    if (
      request === undefined ||
      getActiveApprovalCandidate(session.state, candidate.candidateId) === undefined
    ) {
      continue;
    }
    const processed = await authorizeCandidate({
      candidateId: candidate.candidateId,
      now,
      request,
      responder: candidate.responder,
      session,
      tools: input.tools!,
    });
    session = processed.session;
    didCommit ||= processed.didCommit;
    challenges.push(...processed.challenges);
  }

  return didCommit
    ? deliveryResult(session, remainingStepInput, "continue-coordination")
    : deliveryResult(
        session,
        remainingStepInput,
        challenges.length > 0 ? "authorization-required" : "continue",
        challenges,
      );
}

function candidateReadyForPolicyWork(candidate: ActiveApprovalCandidate): boolean {
  return (
    candidate.status === "pending" ||
    (candidate.authorizationChallenges?.some(
      (challenge) => getAuthorizationResult(challenge.name) !== undefined,
    ) ??
      false)
  );
}

async function authorizeCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly request: InputRequest;
  readonly responder: ActiveApprovalCandidate["responder"];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: boolean;
  readonly session: HarnessSession;
}> {
  // Expiry is checked again immediately before callback/policy execution.
  let session = {
    ...input.session,
    state: expireApprovalCandidates({ now: input.now, state: input.session.state }),
  };
  if (getActiveApprovalCandidate(session.state, input.candidateId) === undefined) {
    return { challenges: [], didCommit: false, session };
  }

  const approval = input.tools.get(input.request.action.toolName)?.approval;
  const responsePolicy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (responsePolicy === undefined) {
    return failCandidate({
      ...input,
      safeReason: "Approval authorization is temporarily unavailable. Please try again.",
      session,
    });
  }

  try {
    const context = buildCallbackContext();
    const outcome = await withAuthorizerTimeout(
      responsePolicy({
        auth: buildApprovalResponseAuth({
          responder: input.responder,
          scope: input.candidateId,
        }),
        request: {
          callId: input.request.action.callId,
          requestId: input.request.requestId,
          toolInput: input.request.action.input,
          toolName: input.request.action.toolName,
        },
        response: { decision: "approve" },
        responder: input.responder,
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          parent: context.session.parent,
          turn: context.session.turn,
        },
      }),
    );
    if (outcome.status === "rejected") {
      session = {
        ...session,
        state: finishApprovalCandidate({
          candidateId: input.candidateId,
          completedAt: input.now,
          safeReason: outcome.safeReason,
          state: session.state,
          status: "rejected",
        }),
      };
      return { challenges: [], didCommit: true, session };
    }
    if (outcome.status !== "allowed") {
      return failCandidate({ ...input, session });
    }

    const settled = settleAllowedCandidate({
      candidateId: input.candidateId,
      settledAt: input.now,
      state: session.state,
    });
    return {
      challenges: [],
      didCommit: settled.result.kind === "settled",
      session: { ...session, state: settled.state },
    };
  } catch (error) {
    const authorization = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    if (isAuthorizationSignal(authorization)) {
      const providerExpiresAt = authorization.challenges
        .map((entry) => Date.parse(entry.challenge.expiresAt ?? ""))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      session = {
        ...session,
        state: markApprovalCandidateAuthorizationRequired({
          authorizationChallenges: authorization.challenges.map((challenge) => ({
            ...challenge,
            candidateId: input.candidateId,
          })),
          candidateId: input.candidateId,
          expiresAt: providerExpiresAt,
          provider: authorization.challenges[0]?.challenge.displayName,
          state: session.state,
        }),
      };
      return {
        challenges: authorization.challenges.map((challenge) => ({
          ...challenge,
          candidateId: input.candidateId,
        })),
        didCommit: true,
        session,
      };
    }
    return failCandidate({ ...input, session });
  }
}

function failCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly request: InputRequest;
  readonly safeReason?: string;
  readonly session: HarnessSession;
}): {
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: true;
  readonly session: HarnessSession;
} {
  const safeReason = input.safeReason ?? "We couldn’t verify your approval. Please try again.";
  return {
    challenges: [],
    didCommit: true,
    session: {
      ...input.session,
      state: finishApprovalCandidate({
        candidateId: input.candidateId,
        completedAt: input.now,
        safeReason,
        state: input.session.state,
        status: "failed",
      }),
    },
  };
}

function removeConsumedResponses(
  stepInput: StepInput | undefined,
  consumed: ReadonlySet<string>,
): StepInput | undefined {
  if (stepInput === undefined) return undefined;
  const attributed = (stepInput.attributedInputResponses ?? []).filter(
    ({ response }) => !consumed.has(response.requestId),
  );
  const plain = (stepInput.inputResponses ?? []).filter(
    (response) => !consumed.has(response.requestId),
  );
  const inputResponses = [...plain, ...attributed.map(({ response }) => response)];
  return {
    ...stepInput,
    attributedInputResponses: undefined,
    inputResponses,
  };
}

function deliveryResult(
  session: HarnessSession,
  stepInput: StepInput | undefined,
  kind: ApprovalDeliveryResult["kind"] = "continue",
  challenges: readonly AuthorizationChallenge[] = [],
  feedback: readonly string[] = [],
): ApprovalDeliveryResult {
  return { challenges, feedback, kind, session, stepInput };
}

function approvalCandidateIdPrefix(requestId: string, responder: SessionAuthContext): string {
  const principal = [
    responder.authenticator,
    responder.issuer ?? "",
    responder.principalType,
    responder.principalId,
  ].join(":");
  return `${encodeCandidateIdPart(requestId)}.${encodeCandidateIdPart(principal)}`;
}

function encodeCandidateIdPart(value: string): string {
  return Array.from(value, (character) => character.codePointAt(0)!.toString(36)).join("-");
}

async function withAuthorizerTimeout<T>(promise: Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Approval response authorizer timed out.")),
          APPROVAL_AUTHORIZER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
