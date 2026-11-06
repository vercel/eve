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
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.subagent-event-proxy");

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
  // Joined sign-ins are completed before the relay commits, so one whose callback can't be
  // delivered commits as its own card rather than as completed.
  const { state } = input.durableSession;
  const planned = relay(sessionView(storedProjection(state), state), {
    payload: hookPayload,
    runId,
    workflowAsk,
  }).signInWakes;
  const delivered = await Promise.all(planned.map(completeJoinedSignIn));
  const undeliveredWakes = new Set(planned.filter((_, index) => !delivered[index]));
  return await commitSessionStep(
    input,
    (view) => [relay(view, { payload: hookPayload, runId, workflowAsk, undeliveredWakes })],
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
 * Calls a joined sign-in's callback, as Connect calls the shown one's: its asker matches the
 * attempt in its own turn and reads the stored grant for its own principal. The URL carries no
 * provider params, which a Connect grant's completion never reads.
 */
async function completeJoinedSignIn(callbackUrl: string): Promise<boolean> {
  const callback = parseEveConnectionCallbackRoutePath(new URL(callbackUrl).pathname);
  if (callback === undefined) {
    log.warn("a joined sign-in's callback URL names no attempt", { callbackUrl });
    return false;
  }
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
    return true;
  } catch (error) {
    // Its asker's session is gone, so nothing waits on the sign-in anymore.
    if (HookNotFoundError.is(error)) return true;
    log.warn("couldn't complete a joined sign-in; it shows its own card", {
      attemptId: callback.attemptId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
