import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getActiveApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
  type ActiveApprovalResponseAttempt,
  type ApprovalSettlementAuditRecord,
} from "#harness/hitl/approval-response-attempts.js";
import {
  clearPendingAuthorization,
  getAuthorizationResult,
  getPendingAuthorization,
  isAuthorizationSignal,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const UNAUTHENTICATED_APPROVAL_FEEDBACK = "Authentication is required to respond to this approval.";
const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

export interface ApprovalDeliveryResult {
  readonly challenges: readonly AuthorizationChallenge[];
  readonly feedback: readonly string[];
  readonly kind: "continue" | "continue-coordination" | "authorization-required" | "park";
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}

export function shouldPrepareApprovalResponsePolicies(input: {
  readonly now?: number;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): boolean {
  const batches = getPendingInputBatches(input.session.state);
  const responses = [
    ...(input.stepInput?.attributedInputResponses ?? []).map(({ response }) => response),
    ...(input.stepInput?.inputResponses ?? []),
  ];
  if (
    batches.some((batch) =>
      batch.requests.some(
        (request) =>
          isApprovalRequest(request) &&
          responses.some((response) => response.requestId === request.requestId),
      ),
    )
  ) {
    return false;
  }

  const now = input.now ?? Date.now();
  return getApprovalAuditState(input.session.state).activeCandidates.some(
    (attempt) =>
      attempt.expiresAt > now &&
      (attempt.status === "pending" ||
        (getPendingAuthorization(input.session.state)?.challenges.some(
          (challenge) =>
            challenge.candidateId === attempt.candidateId &&
            getAuthorizationResult(challenge.name) !== undefined,
        ) ??
          false)),
  );
}

export async function interpretApprovalResponses(input: {
  readonly now?: number;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
}): Promise<ApprovalDeliveryResult> {
  const now = input.now ?? Date.now();
  const expiredChallengeNames = getApprovalAuditState(input.session.state)
    .activeCandidates.filter((attempt) => attempt.expiresAt <= now)
    .flatMap(
      (attempt) =>
        getPendingAuthorization(input.session.state)
          ?.challenges.filter((challenge) => challenge.candidateId === attempt.candidateId)
          .map((challenge) => challenge.name) ?? [],
    );
  const expiredState = expireApprovalCandidates({ now, state: input.session.state });
  let session: HarnessSession = {
    ...input.session,
    state: clearPendingAuthorization(expiredState, expiredChallengeNames),
  };
  const audit = getApprovalAuditState(session.state);
  const batches = getPendingInputBatches(session.state);
  const pendingRequestIds = new Set(
    batches.flatMap((batch) => batch.requests.map((request) => request.requestId)),
  );
  const pendingSettlements = audit.settlements.filter((settlement) =>
    pendingRequestIds.has(settlement.requestId),
  );
  const settledRequestIds = new Set(audit.settlements.map((settlement) => settlement.requestId));
  const discardedDuplicate = hasResponseForRequest(input.stepInput, settledRequestIds);
  const deduplicatedInput = discardedDuplicate
    ? removeConsumedResponses(input.stepInput, settledRequestIds)
    : input.stepInput;
  if (
    discardedDuplicate &&
    pendingSettlements.length === 0 &&
    !hasMeaningfulInput(deduplicatedInput)
  ) {
    return deliveryResult(session, deduplicatedInput, "park");
  }
  if (batches.length === 0) return deliveryResult(session, deduplicatedInput);

  const stepInput = deduplicatedInput;
  const authorizationRequiredRequestIds = new Set(
    batches.flatMap((batch) => batch.responseAuthRequiredRequestIds ?? []),
  );
  const allRequests = batches.flatMap((batch) => batch.requests);
  const requests = new Map(allRequests.map((request) => [request.requestId, request]));
  const challenges: AuthorizationChallenge[] = [];
  const feedback: string[] = [];
  const consumed = new Set<string>();
  let didCommit = false;
  const attemptsAtStart = getApprovalAuditState(session.state).activeCandidates;

  const deliveredResponses = [
    ...(stepInput?.attributedInputResponses ?? []),
    ...(stepInput?.inputResponses ?? []).map((response) => ({
      auth: undefined,
      deliveryId: undefined,
      response,
    })),
  ];
  for (const { auth: attributedResponder, deliveryId, response } of deliveredResponses) {
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
        const settled = settleDirectApprovalResponse({
          actor: responder,
          outcome: response.optionId === "approve" ? "allowed" : "cancelled",
          requestId: response.requestId,
          settledAt: now,
          state: session.state,
        });
        session = { ...session, state: settled.state };
        didCommit ||= settled.changed;
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
      const settled = settleDirectApprovalResponse({
        actor: responder,
        outcome: "cancelled",
        requestId: response.requestId,
        settledAt: now,
        state: session.state,
      });
      session = { ...session, state: settled.state };
      didCommit ||= settled.changed;
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
      deliveryId,
      expiresAt: now + APPROVAL_CANDIDATE_TTL_MS,
      requestId: request.requestId,
      responder,
      state: session.state,
    });
    session = { ...session, state: created.state };
    didCommit ||= created.changed;
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
  if (didCommit) {
    return deliveryResult(session, remainingStepInput, "continue", [], feedback);
  }

  const parkedChallengeNames = new Set(
    getPendingAuthorization(session.state)?.challenges.map((challenge) => challenge.name) ?? [],
  );
  for (const attempt of attemptsAtStart) {
    if (attempt.status === "authorization-required") {
      const attemptChallenges =
        getPendingAuthorization(session.state)?.challenges.filter(
          (challenge) => challenge.candidateId === attempt.candidateId,
        ) ?? [];
      const hasCallback = attemptChallenges.some(
        (challenge) => getAuthorizationResult(challenge.name) !== undefined,
      );
      if (!hasCallback) {
        challenges.push(
          ...attemptChallenges.filter((challenge) => !parkedChallengeNames.has(challenge.name)),
        );
        continue;
      }
    }

    const request = requests.get(attempt.requestId);
    if (
      request === undefined ||
      getActiveApprovalCandidate(session.state, attempt.candidateId) === undefined
    ) {
      continue;
    }
    const processed = await authorizeCandidate({
      candidateId: attempt.candidateId,
      now,
      request,
      responder: attempt.responder,
      session,
      tools: input.tools,
    });
    session = processed.session;
    didCommit ||= processed.didCommit;
    challenges.push(...processed.challenges);
    const settlement = getApprovalAuditState(session.state).settlements.find(
      (entry) => entry.requestId === attempt.requestId,
    );
    if (settlement !== undefined) pendingSettlements.push(settlement);
  }

  const resumedStepInput = appendSettledResponses(remainingStepInput, pendingSettlements);
  if (pendingSettlements.length > 0) {
    return deliveryResult(session, resumedStepInput, "continue");
  }
  return didCommit
    ? deliveryResult(session, resumedStepInput, "continue-coordination")
    : deliveryResult(
        session,
        resumedStepInput,
        challenges.length > 0 ? "authorization-required" : "continue",
        challenges,
      );
}

async function authorizeCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly request: InputRequest;
  readonly responder: ActiveApprovalResponseAttempt["responder"];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: boolean;
  readonly session: HarnessSession;
}> {
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
      reason: "Approval authorization is temporarily unavailable. Please try again.",
      session,
    });
  }

  try {
    const context = buildCallbackContext();
    const outcome = await withAuthorizerTimeout(
      Promise.resolve(
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
      ),
    );
    if (outcome.status === "rejected") {
      session = {
        ...session,
        state: finishApprovalCandidate({
          candidateId: input.candidateId,
          completedAt: input.now,
          reason: outcome.reason,
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
      didCommit: settled.changed,
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

async function failCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly request: InputRequest;
  readonly reason?: string;
  readonly responder: ActiveApprovalResponseAttempt["responder"];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: boolean;
  readonly session: HarnessSession;
}> {
  return {
    challenges: [],
    didCommit: true,
    session: {
      ...input.session,
      state: finishApprovalCandidate({
        candidateId: input.candidateId,
        completedAt: input.now,
        reason: input.reason,
        state: input.session.state,
        status: "failed",
      }),
    },
  };
}

function approvalCandidateIdPrefix(requestId: string, responder: SessionAuthContext): string {
  return `${requestId}:${responder.authenticator}:${responder.principalType}:${responder.principalId}`;
}

function hasResponseForRequest(stepInput: StepInput | undefined, requestIds: Set<string>): boolean {
  return [
    ...(stepInput?.attributedInputResponses ?? []).map(({ response }) => response),
    ...(stepInput?.inputResponses ?? []),
  ].some((response) => requestIds.has(response.requestId));
}

function removeConsumedResponses(
  stepInput: StepInput | undefined,
  consumedRequestIds: Set<string>,
): StepInput | undefined {
  if (stepInput === undefined || consumedRequestIds.size === 0) return stepInput;
  const attributedInputResponses = stepInput.attributedInputResponses?.filter(
    ({ response }) => !consumedRequestIds.has(response.requestId),
  );
  const inputResponses = stepInput.inputResponses?.filter(
    (response) => !consumedRequestIds.has(response.requestId),
  );
  return {
    ...stepInput,
    attributedInputResponses:
      attributedInputResponses && attributedInputResponses.length > 0
        ? attributedInputResponses
        : undefined,
    inputResponses: inputResponses && inputResponses.length > 0 ? inputResponses : undefined,
  };
}

function appendSettledResponses(
  stepInput: StepInput | undefined,
  settlements: readonly ApprovalSettlementAuditRecord[],
): StepInput | undefined {
  if (settlements.length === 0) return stepInput;
  return {
    ...stepInput,
    inputResponses: [
      ...(stepInput?.inputResponses ?? []),
      ...settlements.map((settlement) => ({
        optionId: settlement.outcome === "allowed" ? "approve" : "cancel",
        requestId: settlement.requestId,
      })),
    ],
  };
}

function hasMeaningfulInput(stepInput: StepInput | undefined): boolean {
  return Boolean(
    stepInput?.message ||
    (stepInput?.context && stepInput.context.length > 0) ||
    (stepInput?.inputResponses && stepInput.inputResponses.length > 0) ||
    (stepInput?.attributedInputResponses && stepInput.attributedInputResponses.length > 0),
  );
}

function deliveryResult(
  session: HarnessSession,
  stepInput?: StepInput,
  kind: ApprovalDeliveryResult["kind"] = "continue",
  challenges: readonly AuthorizationChallenge[] = [],
  feedback: readonly string[] = [],
): ApprovalDeliveryResult {
  return { challenges, feedback, kind, session, stepInput };
}

async function withAuthorizerTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("Approval response policy timed out.")),
        APPROVAL_AUTHORIZER_TIMEOUT_MS,
      );
    }),
  ]);
}
