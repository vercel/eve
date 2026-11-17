import type { SessionAuthContext } from "#channel/types.js";
import { principalOf } from "#execution/session/principal.js";
import { openRequests } from "#protocol/session-projection/reader.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";

export function attributeAnswers(input: {
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
  return {
    ...stepInput,
    answers: kept.map((answer) =>
      own.get(answer.interactionId) === "approval"
        ? { ...answer, responder: input.responder }
        : answer,
    ),
  };
}
