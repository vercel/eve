import type { ModelMessage } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import {
  hasAnsweredApprovalBatch,
  resolveApprovalInputBatches,
} from "#harness/hitl/approval-input-requests.js";
import { compactStepInput } from "#harness/hitl/pending-input-resolution.js";
import type {
  ResolvePendingInputResult,
  ResolvedStepInput,
} from "#harness/hitl/pending-input-resolution.js";
import { resolveQuestionOnlyInputBatches } from "#harness/hitl/question-input-requests.js";
import {
  isSessionLimitInputBatch,
  resolveSessionLimitInput,
} from "#harness/hitl/session-limit-input-requests.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import { getPendingInputBatches, queueDeferredStepInput } from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/**
 * Resolves pending input at the start of a harness step.
 *
 * Ordered batches remain independently answerable. Session-limit prompts own
 * resolution while open; approval batches preserve AI SDK's tail-message
 * requirement; question-only batches retain dismiss-and-continue behavior.
 */
export function interpretRequestDelivery(input: {
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
    route.kind === "approval" &&
    input.deferMessagesWhileApprovalsPending === true &&
    resolvedStepInput?.message !== undefined &&
    !hasAnsweredApprovalBatch(route.approvalBatches, responses)
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
    case "approval":
      return resolveApprovalInputBatches({
        ...resolverInput,
        approvalBatches: route.approvalBatches,
        questionBatches: route.questionBatches,
        resolveApprovalKey: input.resolveApprovalKey,
      });
    case "question":
      return resolveQuestionOnlyInputBatches(resolverInput);
  }
}

type PendingInputRoute =
  | { readonly batch: PendingInputBatch; readonly kind: "session-limit" }
  | {
      readonly approvalBatches: readonly PendingInputBatch[];
      readonly kind: "approval";
      readonly questionBatches: readonly PendingInputBatch[];
    }
  | { readonly kind: "question" };

type PendingInputBatchDomain = "approval" | "question" | "session-limit";

function routePendingInput(batches: readonly PendingInputBatch[]): PendingInputRoute {
  const classified = batches.map((batch) => ({ batch, domain: classifyPendingInputBatch(batch) }));
  const limitBatch = classified.find(({ domain }) => domain === "session-limit")?.batch;
  if (limitBatch !== undefined) return { batch: limitBatch, kind: "session-limit" };

  const approvalBatches = classified
    .filter(({ domain }) => domain === "approval")
    .map(({ batch }) => batch);
  if (approvalBatches.length > 0) {
    const approvalSet = new Set(approvalBatches);
    return {
      approvalBatches,
      kind: "approval",
      questionBatches: batches.filter((batch) => !approvalSet.has(batch)),
    };
  }

  return { kind: "question" };
}

function classifyPendingInputBatch(batch: PendingInputBatch): PendingInputBatchDomain {
  for (const request of batch.requests) {
    switch (request.kind) {
      case "question":
      case "session-limit":
      case "tool-approval":
        break;
      default: {
        const unhandled: never = request.kind;
        throw new TypeError(`Unhandled pending input request kind: ${String(unhandled)}`);
      }
    }
  }

  if (isSessionLimitInputBatch(batch)) return "session-limit";
  return batch.requests.some((request) => isApprovalRequest(request)) ? "approval" : "question";
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

function hasTailApprovalResponse(messages: readonly ModelMessage[]): boolean {
  const tail = messages.at(-1);
  return (
    tail?.role === "tool" && tail.content.some((part) => part.type === "tool-approval-response")
  );
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
