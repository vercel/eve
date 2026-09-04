import { start, type Run } from "#internal/workflow/runtime.js";
import type { SessionResources } from "#execution/session/resources.js";
import type { AcceptedSubmission, TurnReceipt, TurnWorkflowInput } from "#execution/turn/types.js";

import { turnWorkflowReference } from "#execution/workflow-references.js";

export async function dispatchTurn(
  session: SessionResources,
  submission: AcceptedSubmission,
  afterRunId?: string,
): Promise<Run<TurnReceipt>> {
  const input: TurnWorkflowInput = {
    session,
    submission,
    afterRunId,
  };
  const run =
    submission.acceptedDeploymentId === undefined
      ? await start(turnWorkflowReference, [input])
      : await start(turnWorkflowReference, [input], {
          deploymentId: submission.acceptedDeploymentId,
        });
  return run as Run<TurnReceipt>;
}

export async function deferTurnStep(
  input: TurnWorkflowInput & { readonly afterRunId: string },
): Promise<TurnReceipt> {
  "use step";
  const run = await dispatchTurn(input.session, input.submission, input.afterRunId);
  return { continuedTo: run.runId, deliveries: {}, terminal: false };
}

export async function startTurnStep(
  session: SessionResources,
  submission: AcceptedSubmission,
): Promise<{ readonly runId: string }> {
  "use step";
  const run = await dispatchTurn(session, submission);
  return { runId: run.runId };
}
