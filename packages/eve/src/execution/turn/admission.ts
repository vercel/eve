import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import type { AcceptedSubmission, TurnReceipt } from "#execution/turn/types.js";

/** Follow the actual resumed owner; its durable result accounts for this input. */
export async function forwardSubmissionStep(input: {
  readonly token: string;
  readonly candidateRunId: string;
  readonly submission: AcceptedSubmission;
}): Promise<TurnReceipt | undefined> {
  "use step";
  let owner: { readonly runId: string };
  try {
    owner = await resumeHook(input.token, {
      eventId: input.submission.eventId,
      kind: "session.submit",
      payload: { submission: input.submission, candidateRunId: input.candidateRunId },
    });
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
  return await getRun<TurnReceipt>(owner.runId).returnValue;
}

export async function awaitTurnStep(runId: string): Promise<TurnReceipt> {
  "use step";
  return await waitForTurnReceipt(runId);
}

export async function waitForTurnReceipt(runId: string): Promise<TurnReceipt> {
  const visited = new Set<string>();
  let next = runId;
  while (true) {
    if (visited.has(next) || visited.size >= 256)
      throw new Error("Invalid turn continuation chain.");
    visited.add(next);
    const receipt = await getRun<TurnReceipt>(next).returnValue;
    if (receipt.continuedTo === undefined) return receipt;
    next = receipt.continuedTo;
  }
}
