import type { InputRequest, InputResponse } from "#shared/input.js";
import { buildResolvedInputBatch } from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  buildApprovalBatchToolResponseParts,
  buildRejectedActionBatch,
  recordApprovedTools,
} from "#harness/hitl/approval-input-requests.js";
import {
  appendResolvedBatchTranscript,
  compactStepInput,
  finishResolvedInput,
  responsesForBatches,
} from "#harness/hitl/pending-input-resolution.js";
import type {
  InputDomainResolverInput,
  ResolvePendingInputResult,
} from "#harness/hitl/pending-input-resolution.js";
import { resolveQuestionBatches } from "#harness/hitl/question-input-requests.js";
import { isSessionLimitInputBatch } from "#harness/hitl/session-limit-input-requests.js";
import {
  interpretInput,
  inputReducers,
  type InputEffect,
  type InputGroup,
  type InputRow,
} from "#harness/hitl/input-interpreter.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { isSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";

export type PendingInputGroup = InputGroup & { readonly batch: PendingInputBatch };

export type PendingInputInterpretation = {
  readonly effects: readonly InputEffect[];
  readonly groups: readonly PendingInputGroup[];
  readonly responses: readonly InputResponse[];
  readonly rows: readonly InputRow[];
};

/** Adapts each durable PendingInputBatch to one first-class interpreter group. */
export function interpretPendingInput(input: {
  readonly batches: readonly PendingInputBatch[];
  readonly message: boolean;
  readonly responses: readonly InputResponse[];
}): PendingInputInterpretation {
  const groups = input.batches.map((batch, index): PendingInputGroup => {
    const id = `pending-input-${index}`;
    const kind = isSessionLimitInputBatch(batch)
      ? "limit"
      : batch.requests.some(isApprovalRequest)
        ? "approval"
        : "question";
    const rows = batch.requests.map((request): InputRow => ({
      groupId: id,
      id: request.requestId,
      request,
      variant:
        request.kind === "tool-approval"
          ? "approval"
          : request.kind === "session-limit"
            ? "limit"
            : "question",
    }));
    return { batch, id, kind, rows };
  });
  const rows = groups.flatMap((group) => group.rows);

  return {
    effects: interpretInput({
      groups,
      message: input.message,
      reducers: inputReducers,
      responses: input.responses,
    }),
    groups,
    responses: input.responses,
    rows,
  };
}

export function hasSettledApprovalBatch(interpretation: PendingInputInterpretation): boolean {
  return claimedGroups(interpretation).some((group) => group.kind === "approval");
}

/** Formats claimed interpreter groups into transcript and session mutations. */
export function translatePendingInputEffects(
  input: InputDomainResolverInput & {
    readonly interpretation: PendingInputInterpretation;
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  },
): ResolvePendingInputResult {
  const groups = input.interpretation.groups;
  const claimed = claimedGroups(input.interpretation);
  const claimedBatches = claimed.map((group) => group.batch);
  const openBatches = groups
    .filter((group) => !claimed.includes(group))
    .map((group) => group.batch);
  const leftoverResponses = responsesForBatches(input.responses, openBatches);
  const limitGroup = groups.find((group) => group.kind === "limit");

  if (claimed.length === 0) {
    if (limitGroup !== undefined) {
      return {
        deferredMessage: true,
        outcome: "unresolved",
        messages: [...input.baseHistory],
        session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
      };
    }
    return unresolvedOrContinue(input, leftoverResponses);
  }

  if (claimed[0]?.kind === "limit") {
    const limitBlocked = openBatches.some((batch) =>
      batch.requests.some((request) => isSessionLimitContinuationRequest(request)),
    );
    const messages = [...input.baseHistory];
    appendResolvedBatchTranscript(messages, claimed[0].batch, []);
    const stopped = input.interpretation.effects.some(
      (effect) =>
        effect.kind === "settled" && effect.row.variant === "limit" && effect.outcome === "stopped",
    );
    return finishResolvedInput({
      deferTurnInput: input.deferTurnInput || limitBlocked,
      leftoverResponses,
      limitContinuation: { granted: !stopped },
      messages,
      resolvedInputs: resolvedInputs(claimedBatches, input.responses),
      resolvedStepInput: input.resolvedStepInput,
      session: removePendingInputBatches(input.session, claimedBatches),
    });
  }

  const approvalGroup = claimed.find((group) => group.kind === "approval");
  const messages = resolveQuestionBatches({
    batches: claimed.filter((group) => group !== approvalGroup).map((group) => group.batch),
    messages: [...input.baseHistory],
    responses: input.responses,
  });
  let session = input.session;
  let rejectedActions;
  if (approvalGroup !== undefined) {
    appendResolvedBatchTranscript(
      messages,
      approvalGroup.batch,
      buildApprovalBatchToolResponseParts(approvalGroup.batch, input.responses),
    );
    session = recordApprovedTools({
      pendingBatch: approvalGroup.batch,
      resolveApprovalKey: input.resolveApprovalKey,
      responses: input.responses,
      session,
    });
    const rejected = buildRejectedActionBatch(approvalGroup.batch, input.responses);
    rejectedActions = rejected === undefined ? undefined : [rejected];
  }

  return finishResolvedInput({
    deferTurnInput: approvalGroup !== undefined || input.deferTurnInput,
    leftoverResponses,
    messages,
    rejectedActions,
    resolvedInputs: resolvedInputs(claimedBatches, input.responses),
    resolvedStepInput: input.resolvedStepInput,
    session: removePendingInputBatches(session, claimedBatches),
  });
}

type TranslationInput = InputDomainResolverInput & {
  readonly interpretation: PendingInputInterpretation;
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
};

function claimedGroups(interpretation: PendingInputInterpretation): readonly PendingInputGroup[] {
  const ids = new Set(
    interpretation.effects
      .filter((effect) => effect.kind === "claim-group")
      .map((effect) => effect.group.id),
  );
  return interpretation.groups.filter((group) => ids.has(group.id));
}

function unresolvedOrContinue(
  input: TranslationInput,
  leftoverResponses: readonly InputResponse[],
): ResolvePendingInputResult {
  if (input.resolvedStepInput?.message === undefined) {
    return {
      outcome: "unresolved",
      messages: [...input.baseHistory],
      session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
    };
  }
  return {
    consumedMessage: input.resolvedStepInput.messageConsumed,
    outcome: "continue",
    messages: [...input.baseHistory],
    session:
      leftoverResponses.length === 0
        ? input.session
        : queueDeferredStepInput(input.session, { inputResponses: leftoverResponses }),
  };
}

function resolvedInputs(
  batches: readonly PendingInputBatch[],
  responses: readonly InputResponse[],
) {
  return batches.flatMap((batch) => {
    const resolved = buildResolvedInputBatch(batch, responses);
    return resolved === undefined ? [] : [resolved];
  });
}
