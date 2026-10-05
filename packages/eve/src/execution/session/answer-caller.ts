import type { SessionAuthContext } from "#channel/types.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";

/**
 * Answering a request does not make the responder the turn's caller. When
 * `stepInput` only answers pending requests, returns it with each approval
 * answer carrying its responder, so approval policies and the approved call
 * see the responder while the turn keeps its caller. Returns `undefined` when
 * the input carries anything else, such as a message or a stale answer; its
 * sender becomes the caller.
 */
export function attributeAnswers(input: {
  readonly responder: SessionAuthContext | null;
  readonly state: SessionStateMap | undefined;
  readonly stepInput: StepInput | undefined;
}): StepInput | undefined {
  const { stepInput } = input;
  const responses = stepInput?.inputResponses ?? [];
  if (stepInput === undefined || stepInput.message !== undefined || responses.length === 0) {
    return undefined;
  }
  const requests = new Map(
    getPendingInputBatches(input.state).flatMap((batch) =>
      batch.requests.map((request) => [request.requestId, request.kind] as const),
    ),
  );
  if (!responses.every((response) => requests.has(response.requestId))) return undefined;

  const approvals = responses.filter(
    (response) => requests.get(response.requestId) === "tool-approval",
  );
  const others = responses.filter(
    (response) => requests.get(response.requestId) !== "tool-approval",
  );
  // An unauthenticated approval stays attributed to no one; it must never pass
  // as the turn's caller.
  const { inputResponses: _answered, ...rest } = stepInput;
  const result: StepInput = {
    ...rest,
    attributedInputResponses: [
      ...(stepInput.attributedInputResponses ?? []),
      ...approvals.map((response) => ({ auth: input.responder, response })),
    ],
  };
  return others.length === 0 ? result : { ...result, inputResponses: others };
}
