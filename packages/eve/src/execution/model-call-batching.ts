import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds, runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession, HarnessStepInput, StepResult } from "#harness/types.js";
import { openSignIns } from "#protocol/session-reader.js";

export async function runModelCallBatch(input: {
  readonly steeringSignal?: AbortSignal;
  readonly initialInput: HarnessStepInput | undefined;
  readonly initialSession: HarnessSession;
  readonly modelCallsPerStep: number;
  readonly runStep: (input: {
    readonly firstCall: boolean;
    readonly session: HarnessSession;
    readonly stepInput: HarnessStepInput | undefined;
  }) => Promise<StepResult>;
}): Promise<StepResult> {
  let session = input.initialSession;
  let stepInput = input.initialInput;
  let completedModelCalls = 0;

  while (true) {
    const result = await input.runStep({
      firstCall: completedModelCalls === 0,
      session,
      stepInput,
    });
    completedModelCalls++;
    // A steered result leaves the signal aborted until the turn takes the steering message.
    if (
      input.steeringSignal?.aborted === true ||
      !shouldRunAnotherModelCall({
        completedModelCalls,
        modelCallsPerStep: input.modelCallsPerStep,
        result,
      })
    ) {
      return result;
    }
    session = result.session;
    stepInput = undefined;
  }
}

function shouldRunAnotherModelCall(input: {
  readonly completedModelCalls: number;
  readonly modelCallsPerStep: number;
  readonly result: StepResult;
}): boolean {
  if (input.completedModelCalls >= input.modelCallsPerStep || input.result.again !== true) {
    return false;
  }

  // Each step saves the lifecycle it published with its result.
  return !waitsOnAnything(input.result.session);
}

/** Whether the turn waits on a sign-in, an answer, or a call, which ends a batch of model calls. */
function waitsOnAnything(session: HarnessSession): boolean {
  const projection = storedProjection(session.state);
  return (
    openSignIns(projection.view).length > 0 ||
    ownOpenRequestIds(sessionView(projection, session.state)).size > 0 ||
    (runtimeWait(session.state)?.callIds.length ?? 0) > 0
  );
}
