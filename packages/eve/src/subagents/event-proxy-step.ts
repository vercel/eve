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
import { relay, type RelayTransition } from "#harness/session-machine/transitions.js";
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
  let relayed: RelayTransition | undefined;
  const published = await commitSessionStep(
    input,
    (view) => [(relayed = relay(view, { payload: hookPayload, runId, workflowAsk }))],
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
  await Promise.all((relayed?.signInWakes ?? []).map(completeJoinedSignIn));
  return published;
}

/**
 * Calls a joined sign-in's callback, as Connect calls the shown one's: its asker matches the
 * attempt in its own turn and reads the stored grant for its own principal. The URL carries no
 * provider params, which a Connect grant's completion never reads.
 */
async function completeJoinedSignIn(callbackUrl: string): Promise<void> {
  const callback = parseEveConnectionCallbackRoutePath(new URL(callbackUrl).pathname);
  if (callback === undefined) {
    log.warn("a joined sign-in's callback URL names no attempt", { callbackUrl });
    return;
  }
  try {
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
    await resumeRunnableHook(callback.token, payload);
  } catch (error) {
    // The asker stopped waiting first, as when its task ended: nothing is left to complete.
    log.warn("a joined sign-in's asker no longer waits on it", {
      attemptId: callback.attemptId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
