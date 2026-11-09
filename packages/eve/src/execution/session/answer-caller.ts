import type { SessionAuthContext } from "#channel/types.js";
import { principalOf } from "#execution/session/principal.js";
import { openRequests } from "#protocol/session-projection/reader.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";

/**
 * Answering a request does not make the responder the turn's caller. When
 * `stepInput` only answers requests, returns it with each answer to an open
 * approval naming its responder, so approval policies and the approved call
 * see the responder while the turn keeps its caller. Another principal's
 * answer to a request that is no longer open settles nothing, and as text it
 * would steer the open turn, so it is dropped. Returns `undefined` when the
 * input carries a message, or only stale answers the sender may turn into
 * text; its sender becomes the caller.
 */
export function attributeAnswers(input: {
  /** The open turn's caller; `undefined` when the delivery starts a turn. */
  readonly owner?: SessionAuthContext | null;
  readonly responder: SessionAuthContext | null;
  readonly state: SessionStateMap | undefined;
  readonly stepInput: HarnessStepInput | undefined;
}): HarnessStepInput | undefined {
  const { stepInput } = input;
  const responses = stepInput?.answers ?? [];
  if (stepInput === undefined || stepInput.message !== undefined || responses.length === 0) {
    return undefined;
  }
  const view = storedProjection(input.state).view;
  const open = openRequests(view);
  // The session's own requests; a relayed one belongs to the run that asked.
  const own = new Map(
    open.flatMap((row) =>
      row.origin === undefined && interactionOwner(view, row).taskId === undefined
        ? [[row.interactionId, row.request.kind] as const]
        : [],
    ),
  );
  const openIds = new Set(open.map((row) => row.interactionId));
  const foreign =
    input.owner !== undefined && principalOf(input.owner) !== principalOf(input.responder);
  const kept = responses.filter((answer) => !foreign || openIds.has(answer.interactionId));
  if (kept.length === responses.length && !kept.some((answer) => own.has(answer.interactionId))) {
    return undefined;
  }
  // An unauthenticated approval stays attributed to no one; it must never pass
  // as the turn's caller.
  return {
    ...stepInput,
    answers: kept.map((answer) =>
      own.get(answer.interactionId) === "approval"
        ? { ...answer, responder: input.responder }
        : answer,
    ),
  };
}
