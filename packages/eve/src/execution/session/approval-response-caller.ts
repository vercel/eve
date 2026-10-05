import type { SessionAuthContext } from "#channel/types.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";

/**
 * An approval answer authorizes the approved call; it does not make the
 * responder the turn's caller. When `stepInput` only answers pending tool
 * approvals, each answer carries its responder, so policies and the approved
 * call see the responder while the turn keeps its caller. Returns `undefined`
 * for any other input, whose sender becomes the caller as before.
 */
export function attributeApprovalAnswers(input: {
  readonly responder: SessionAuthContext | null;
  readonly state: SessionStateMap | undefined;
  readonly stepInput: StepInput | undefined;
}): StepInput | undefined {
  const { stepInput } = input;
  const responses = stepInput?.inputResponses ?? [];
  if (stepInput === undefined || stepInput.message !== undefined || responses.length === 0) {
    return undefined;
  }
  const approvalIds = new Set(
    getPendingInputBatches(input.state).flatMap((batch) =>
      batch.requests.flatMap((request) =>
        request.kind === "tool-approval" ? [request.requestId] : [],
      ),
    ),
  );
  if (!responses.every((response) => approvalIds.has(response.requestId))) return undefined;

  // An unauthenticated answer stays attributed to no one; it must never pass
  // as the turn's caller.
  const { inputResponses: _answered, ...rest } = stepInput;
  return {
    ...rest,
    attributedInputResponses: [
      ...(stepInput.attributedInputResponses ?? []),
      ...responses.map((response) => ({ auth: input.responder, response })),
    ],
  };
}
