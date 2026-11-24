import { processApp } from "#runtime/app.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import type {
  Entered,
  PublishedSessionEvents,
  SessionStepInput,
  SessionStepState,
} from "#execution/publish-session-events.js";
import { commitSessionStep } from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { readHitlState } from "#harness/hitl/index.js";
import type { Relay } from "#harness/hitl/relays.js";
import { finishRun } from "#harness/session-machine/transitions.js";

export async function withdrawWorkflowToolRunQuestionStep(
  input: WithdrawQuestionInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(processApp().hosts, input, withdrawWorkflowToolRunQuestion);
}

type WithdrawQuestionInput = SessionStepInput & {
  readonly control: string;
  readonly requestId: string;
  readonly runId: string;
};

async function withdrawWorkflowToolRunQuestion(
  input: Entered<WithdrawQuestionInput>,
): Promise<PublishedSessionEvents> {
  const decision: WorkflowToolRunControlMessage = {
    kind: "withdrawn",
    requestId: input.requestId,
  };
  await ignoreGoneTarget(resumeRoutedHook(processApp().hosts, input.control, decision));
  return await relayWithdrawnRequests(
    input,
    (requestId, route) =>
      requestId === input.requestId &&
      route.workflowAsk !== undefined &&
      route.runId === input.runId,
  );
}

export async function withdrawFinishedRunQuestionsStep(
  input: SessionStepInput & { readonly runId: string },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(processApp().hosts, input, (target) =>
    relayWithdrawnRequests(target, (_requestId, route) => route.runId === target.runId),
  );
}

export async function relayWithdrawnRequests(
  input: SessionStepState,
  select: (requestId: string, route: Relay) => boolean,
): Promise<PublishedSessionEvents> {
  const { state } = readDurableSession(input.sessionState);
  const requestIds = [...readHitlState(state).relays]
    .filter(([requestId, route]) => select(requestId, route))
    .map(([requestId]) => requestId);
  return await commitSessionStep(input, (view) => [finishRun(view, { requestIds })], {
    origin: "relayed",
  });
}
