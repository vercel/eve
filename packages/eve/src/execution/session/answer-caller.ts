import type { SessionAuthContext } from "#channel/types.js";
import { principalOf } from "#execution/session/principal.js";
import { openInputs } from "#protocol/session-projection.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";

/**
 * Answering a request does not make the responder the turn's caller. When
 * `stepInput` only answers requests, returns it with each answer to an open
 * approval carrying its responder, so approval policies and the approved call
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
  readonly stepInput: StepInput | undefined;
}): StepInput | undefined {
  const { stepInput } = input;
  const responses = stepInput?.inputResponses ?? [];
  if (stepInput === undefined || stepInput.message !== undefined || responses.length === 0) {
    return undefined;
  }
  const open = openInputs(storedProjection(input.state));
  // The session's own requests; a relayed one belongs to the run that asked.
  const own = new Map(
    open.flatMap((entry) =>
      entry.taskId === undefined && entry.callId === undefined
        ? [[entry.request.requestId, entry.request.kind] as const]
        : [],
    ),
  );
  const openIds = new Set(open.map((entry) => entry.request.requestId));
  const foreign =
    input.owner !== undefined && principalOf(input.owner) !== principalOf(input.responder);
  const kept = responses.filter((response) => !foreign || openIds.has(response.requestId));
  if (kept.length === responses.length && !kept.some((r) => own.has(r.requestId))) {
    return undefined;
  }

  const approvals = kept.filter((response) => own.get(response.requestId) === "tool-approval");
  const others = kept.filter((response) => own.get(response.requestId) !== "tool-approval");
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
