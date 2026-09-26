import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import {
  markWorkflowToolRunReplied,
  removeBlockingWorkflowToolRuns,
  type BlockingWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";

interface RepliedRunStepInput {
  readonly record: BlockingWorkflowToolRun;
  readonly sessionState: DurableSessionState;
}

/** Records that `ctx.reply()` settled the run's call, so the session keeps tracking the run. */
export async function markWorkflowToolRunRepliedStep(
  input: RepliedRunStepInput,
): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = markWorkflowToolRunReplied(readDurableSession(input.sessionState), input.record);
  return { sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }) };
}

/** Stops tracking a run that replied and has now finished, and drops its unanswered questions. */
export async function forgetRepliedWorkflowToolRunStep(
  input: RepliedRunStepInput,
): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const { record } = input;
  const withoutQuestions = clearProxyInputRequestsWhere(
    readDurableSession(input.sessionState),
    (route) => route.answerHook?.runId === record.address.runId,
  );
  const session = removeBlockingWorkflowToolRuns(
    withoutQuestions,
    record.origin.turnId,
    record.callId,
  );
  return { sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }) };
}
