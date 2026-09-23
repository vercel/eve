import type { ModelMessage } from "ai";

import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { hasTailApprovalResponse } from "#harness/current-messages.js";
import {
  getApprovedTools,
  findAnsweredApprovalBatches,
  resolveApprovalInputBatches,
} from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  getDeferredStepInput,
  getPendingInputBatches,
  queueDeferredStepInput,
} from "#harness/pending-input-batches.js";
import { compactStepInput } from "#harness/hitl/pending-input-resolution.js";
import type {
  ResolvePendingInputResult,
  ResolvedStepInput,
} from "#harness/hitl/pending-input-resolution.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import {
  clearPendingSessionLimitPrompt,
  isSessionLimitInputBatch,
  resolveSessionLimitInput,
} from "#harness/hitl/session-limit-input-requests.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";

export { getApprovedTools, clearPendingSessionLimitPrompt };
export type { RejectedActionBatch };
export type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
export {
  appendPendingInputBatch,
  consumeDeferredStepInput,
  getPendingInputRequestIds,
  hasDeferredStepInput,
  hasPendingInputBatch,
} from "#harness/pending-input-batches.js";

/** Returns true when the step input carries user-facing turn input. */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

/** Stored partial answers are not runnable work until they can resolve a batch. */
export function hasRunnableDeferredStepInput(session: HarnessSession): boolean {
  const deferred = getDeferredStepInput(session);
  if (deferred === undefined) return false;
  if (
    deferred.message !== undefined ||
    (deferred.context?.length ?? 0) > 0 ||
    readClientContext(deferred) !== undefined ||
    deferred.outputSchema !== undefined ||
    (deferred.runtimeActionResults?.length ?? 0) > 0
  )
    return true;

  const responses = [
    ...(deferred.inputResponses ?? []),
    ...(deferred.attributedInputResponses ?? []).map(({ response }) => response),
  ];
  if (responses.length === 0) return false;
  const batches = getPendingInputBatches(session.state);
  const route = routePendingInput(batches);
  switch (route.kind) {
    case "session-limit":
      return route.batch.requests.every((request) =>
        responses.some((response) => response.requestId === request.requestId),
      );
    case "approvals":
      return findAnsweredApprovalBatches(batches, responses).length > 0;
  }
}

/** Returns true when any pending batch still contains a tool approval. */
export function hasPendingApprovalBatch(session: HarnessSession): boolean {
  return getPendingInputBatches(session.state).some((batch) =>
    batch.requests.some((request) => isApprovalRequest(request)),
  );
}

/**
 * Resolves pending input at the start of a harness step.
 *
 * Ordered batches remain independently answerable. Session-limit prompts own
 * resolution while open; approval batches preserve AI SDK's tail-message
 * requirement.
 */
export function resolvePendingInput(input: {
  /** The turn currently advancing through the harness tool loop. */
  readonly activeTurnId?: string;
  /** True while the harness has an open turn to continue. */
  readonly internalStep?: boolean;
  readonly deferMessagesWhileApprovalsPending?: boolean;
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
  const batches = getPendingInputBatches(input.session.state);
  if (batches.length === 0) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }

  const route = routePendingInput(batches);
  const deferTurnInput = hasTailApprovalResponse(baseHistory);
  const textResolutionBatch =
    route.kind === "session-limit" ? route.batch : batches.length === 1 ? batches[0] : undefined;
  const resolvedStepInput =
    textResolutionBatch === undefined
      ? input.stepInput
      : resolveTextMessageInput(textResolutionBatch, input.stepInput);
  const responses = canonicalizeInputResponses(resolvedStepInput?.inputResponses ?? []);

  if (
    input.internalStep === true &&
    canContinuePastHistoricalInput({
      activeTurnId: input.activeTurnId,
      batches,
      responses,
      route,
    }) &&
    resolvedStepInput?.message === undefined
  ) {
    return {
      outcome: "continue",
      messages: baseHistory,
      session:
        resolvedStepInput === undefined
          ? input.session
          : queueDeferredStepInput(input.session, compactStepInput(resolvedStepInput)),
    };
  }

  if (
    route.kind === "approvals" &&
    input.deferMessagesWhileApprovalsPending === true &&
    resolvedStepInput?.message !== undefined &&
    findAnsweredApprovalBatches(batches, responses).length === 0
  ) {
    return {
      deferredMessage: true,
      outcome: "unresolved",
      messages: baseHistory,
      session: queueDeferredStepInput(input.session, compactStepInput(resolvedStepInput)),
    };
  }

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    const deferredInput = compactStepInput(resolvedStepInput);
    const session =
      deferredInput.context !== undefined ||
      readClientContext(deferredInput) !== undefined ||
      deferredInput.outputSchema !== undefined
        ? queueDeferredStepInput(input.session, deferredInput)
        : input.session;
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  const resolverInput = {
    baseHistory,
    batches,
    deferTurnInput,
    resolvedStepInput,
    responses,
    session: input.session,
  };
  switch (route.kind) {
    case "session-limit":
      return resolveSessionLimitInput({ ...resolverInput, pendingBatch: route.batch });
    case "approvals":
      return resolveApprovalInputBatches({
        ...resolverInput,
        resolveApprovalKey: input.resolveApprovalKey,
      });
  }
}

/**
 * An internal tool-loop step must not be parked by input emitted by an older
 * turn. The current turn can still park on its own HITL request; session-limit
 * prompts remain a harness gate regardless of the turn that created them.
 */
function canContinuePastHistoricalInput(input: {
  readonly activeTurnId?: string;
  readonly batches: readonly PendingInputBatch[];
  readonly responses: readonly InputResponse[];
  readonly route: PendingInputRoute;
}): boolean {
  if (input.activeTurnId === undefined || input.route.kind === "session-limit") return false;
  if (
    input.responses.length > 0 &&
    findAnsweredApprovalBatches(input.batches, input.responses).length > 0
  ) {
    return false;
  }
  return input.batches.every(
    (batch) => batch.event !== undefined && batch.event.turnId !== input.activeTurnId,
  );
}

type PendingInputRoute =
  | { readonly batch: PendingInputBatch; readonly kind: "session-limit" }
  | { readonly kind: "approvals" };

function routePendingInput(batches: readonly PendingInputBatch[]): PendingInputRoute {
  const limitBatch = batches.find((batch) => isSessionLimitInputBatch(batch));
  if (limitBatch !== undefined) return { batch: limitBatch, kind: "session-limit" };

  for (const batch of batches) {
    for (const request of batch.requests) {
      if (!isApprovalRequest(request)) {
        throw new TypeError(`Unhandled pending input request kind: ${request.kind}`);
      }
    }
  }
  return { kind: "approvals" };
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

function resolveTextMessageInput(
  pendingBatch: PendingInputBatch,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;

  const batchRequestIds = new Set(pendingBatch.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => batchRequestIds.has(response.requestId))) {
    return stepInput;
  }

  const responseAuthRequired = new Set(pendingBatch.responseAuthRequiredRequestIds ?? []);
  const textRequests = pendingBatch.requests.filter(
    (request) => !responseAuthRequired.has(request.requestId),
  );
  const responses = resolveTextToResponses(stepInput.message, textRequests);
  if (responses.length === 0) return stepInput;

  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
    message: undefined,
  });
}

/** Creates a runtime tool-call action shape from an AI SDK tool call. */
export function createRuntimeToolCallActionFromToolCall(input: {
  readonly toolCall: {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  };
}): RuntimeToolCallActionRequest {
  return {
    callId: input.toolCall.toolCallId,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}
