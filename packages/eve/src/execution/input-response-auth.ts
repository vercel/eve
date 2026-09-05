import type { SessionAuthContext } from "#channel/types.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";

/** Separate approval authority from the caller whose suspended work resumes. */
export function attributeInputResponses(input: {
  readonly caller: SessionAuthContext | null;
  readonly responder: SessionAuthContext | null;
  readonly state?: SessionStateMap;
  readonly stepInput?: StepInput;
}): { caller: SessionAuthContext | null; stepInput?: StepInput } {
  const result = { caller: input.responder, stepInput: input.stepInput };
  if (!input.stepInput?.inputResponses?.length) return result;
  const requests = new Map(
    getPendingInputBatches(input.state)
      .flatMap((batch) => batch.requests)
      .map((request) => [request.requestId, request]),
  );
  const { inputResponses, ...rest } = input.stepInput;
  const approvalResponses = inputResponses.filter(
    (response) => requests.get(response.requestId)?.kind === "tool-approval",
  );
  if (approvalResponses.length > 0) {
    const remaining = inputResponses.filter(
      (response) => requests.get(response.requestId)?.kind !== "tool-approval",
    );
    const stepInput: { -readonly [K in keyof StepInput]: StepInput[K] } = {
      ...rest,
      attributedInputResponses: approvalResponses.map((response) => ({
        auth: input.responder,
        response,
      })),
    };
    if (remaining.length > 0) stepInput.inputResponses = remaining;
    result.stepInput = stepInput;
  }
  // Stale answers can become user messages; only live approvals retain the
  // suspended caller. Questions and new messages carry their responder's auth.
  if (
    input.responder !== null &&
    input.stepInput.message === undefined &&
    inputResponses.every((response) => {
      const kind = requests.get(response.requestId)?.kind;
      return kind === "tool-approval" || kind === "session-limit";
    })
  )
    result.caller = input.caller;
  return result;
}
