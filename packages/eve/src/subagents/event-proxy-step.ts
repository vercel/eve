import type { SubagentInteractionHookPayload } from "#channel/types.js";
import {
  commitSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { relay } from "#harness/session-machine/transitions.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";

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
  // The other children hear a sign-in's answer before the relay commits: a delivery that fails
  // fails this step, and its retry plans and delivers them again from the same state.
  const { state } = input.durableSession;
  const { signInWakes } = relay(sessionView(storedProjection(state), state), {
    payload: hookPayload,
    runId,
    workflowAsk,
  });
  await Promise.all(signInWakes.map(completeChildSignIn));
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

/**
 * Calls a child's sign-in callback, as Connect calls the answered one's: the child matches the
 * attempt in its own turn and reads what Connect holds for its own principal, a grant or none.
 * The URL carries no provider params, which a Connect grant's completion never reads.
 */
async function completeChildSignIn(callbackUrl: string): Promise<void> {
  const callback = parseEveConnectionCallbackRoutePath(new URL(callbackUrl).pathname);
  if (callback === undefined)
    throw new Error(`A child's sign-in callback URL names no attempt: ${callbackUrl}`);
  const payload: AuthorizationCallbackPayload = {
    kind: "authorization-callback",
    payloads: [
      {
        authorizationCallback: {
          attemptId: callback.attemptId,
          callback: { method: "GET", params: {} },
          connectionName: callback.name,
        },
      },
    ],
  };
  try {
    await resumeRunnableHook(callback.token, payload);
  } catch (error) {
    // Its asker's session is gone, so nothing waits on the sign-in anymore.
    if (!HookNotFoundError.is(error)) throw error;
  }
}
