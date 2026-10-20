import type { SubagentInteractionHookPayload } from "#channel/types.js";
import {
  commitSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { relay } from "#harness/session-machine/transitions.js";

/** Relays one child interaction fact through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentInteractionHookPayload;
  },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      workflowAsk: target.workflowAsk,
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/**
 * Relays one child interaction fact through the parent session's channel. `runId` names the
 * workflow tool run that relayed it, so the session can withdraw its requests when that run ends.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentInteractionHookPayload;
  },
): Promise<PublishedSessionEvents> {
  const { hookPayload, runId, workflowAsk } = input;
  return await commitSessionStep(
    input,
    (view) => [relay(view, { payload: hookPayload, runId, workflowAsk })],
    {
      origin: "relayed",
      inputSource:
        hookPayload.route === undefined
          ? undefined
          : JSON.stringify([
              hookPayload.route.childContinuationToken,
              hookPayload.route.inputSource ?? null,
            ]),
    },
  );
}
