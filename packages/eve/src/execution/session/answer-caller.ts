import type { SessionAuthContext } from "#channel/types.js";
import { openRequests } from "#protocol/session-projection.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";

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
  readonly stepInput: HarnessStepInput | undefined;
}): HarnessStepInput | undefined {
  const { stepInput } = input;
  const responses = stepInput?.inputResponses ?? [];
  if (stepInput === undefined || stepInput.message !== undefined || responses.length === 0) {
    return undefined;
  }
  // The session's own requests; a relayed one belongs to the run that asked.
  const requests = new Map(
    openRequests(storedProjection(input.state).view).flatMap((open) =>
      open.taskId === undefined && open.callId === undefined
        ? [[open.request.requestId, open.request.kind] as const]
        : [],
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
  const result: HarnessStepInput = {
    ...rest,
    attributedInputResponses: [
      ...(stepInput.attributedInputResponses ?? []),
      ...approvals.map((response) => ({ auth: input.responder, response })),
    ],
  };
  return others.length === 0 ? result : { ...result, inputResponses: others };
}
