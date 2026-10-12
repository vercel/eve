import type { SessionAuthContext } from "#channel/types.js";
import { openRequests } from "#protocol/session-reader.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";
import { publicViewOf } from "#protocol/session-projection.js";

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
  const responses = stepInput?.answers ?? [];
  if (stepInput === undefined || stepInput.message !== undefined || responses.length === 0) {
    return undefined;
  }
  // The session's own requests; a relayed one belongs to the run that asked.
  const view = publicViewOf(storedProjection(input.state));
  const requests = new Map(
    openRequests(view).flatMap((row) =>
      row.origin === undefined && interactionOwner(view, row).taskId === undefined
        ? [[row.interactionId, row.request.kind] as const]
        : [],
    ),
  );
  if (!responses.every((answer) => requests.has(answer.interactionId))) return undefined;
  const approvals = responses.filter((answer) => requests.get(answer.interactionId) === "approval");
  const others = responses.filter((answer) => requests.get(answer.interactionId) !== "approval");
  // An unauthenticated approval stays attributed to no one; it must never pass
  // as the turn's caller.
  const { answers: _answered, ...rest } = stepInput;
  const result: HarnessStepInput = {
    ...rest,
    attributedAnswers: [
      ...(stepInput.attributedAnswers ?? []),
      ...approvals.map((response) => ({ auth: input.responder, response })),
    ],
  };
  return others.length === 0 ? result : { ...result, answers: others };
}
