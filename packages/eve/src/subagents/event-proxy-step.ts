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
import { SIGN_IN_DECLINED, sameRelayedSignIn } from "#harness/hitl/sign-ins.js";
import { relay } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import { authHookToken } from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import { debug6086 } from "#runtime/connections/scoped-authorization.js";

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
  // fails this step, and its retry delivers them again from the same state.
  const tables = storedProjection(input.durableSession.state).view;
  const ownOrigin = await ownCallbackOrigin();
  const answered = answeredSignIns(tables, hookPayload, ownOrigin);
  debug6086("fanIn", {
    callId: hookPayload.callId,
    events: hookPayload.events.map((event) =>
      event.type === "interaction.settled"
        ? `${event.type}:${event.data.interactionId}:${event.data.outcome}`
        : event.type,
    ),
    ownOrigin,
    open: Object.values(tables.interactions)
      .filter((row) => row.status === "open" && row.request.signIn !== undefined)
      .map((row) => ({
        id: row.interactionId,
        childSession: row.origin?.sessionId,
        callbackUrl: row.request.signIn?.callbackUrl,
        local: ownOrigin === undefined ? "no-origin" : localChildCallback(row, ownOrigin) !== undefined,
      })),
    resumed: answered.map((entry) => entry.callback.attemptId),
  });
  await Promise.all(answered.map(settleChildSignIn));
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

/** A child's open sign-in to settle with the answer another child's sign-in got. */
interface AnsweredSignIn {
  readonly callback: { readonly name: string; readonly attemptId: string; readonly token: string };
  readonly params: Readonly<Record<string, string>>;
}

/** The origin this deployment's own sign-in callback URLs use, or `undefined` outside a workflow. */
async function ownCallbackOrigin(): Promise<string | undefined> {
  const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
  const url = getWorkflowMetadata().url;
  return typeof url === "string" ? new URL(resolveWorkflowCallbackBaseUrl(url)).origin : undefined;
}

/**
 * The callback of a sign-in this deployment's own child session asked: its URL is on this
 * deployment's origin and names that session's inbox. A remote child's callback belongs to its own
 * deployment's world, and the parent never resumes a hook a child's URL merely names.
 */
export function localChildCallback(
  row: Pick<InteractionRow, "origin" | "request">,
  ownOrigin: string,
): AnsweredSignIn["callback"] | undefined {
  const callbackUrl = row.request.signIn?.callbackUrl;
  if (callbackUrl === undefined || row.origin === undefined || !URL.canParse(callbackUrl))
    return undefined;
  const url = new URL(callbackUrl);
  if (url.origin !== ownOrigin) return undefined;
  const callback = parseEveConnectionCallbackRoutePath(url.pathname);
  return callback?.token === authHookToken(row.origin.sessionId) ? callback : undefined;
}

/**
 * The other children's open sign-ins the person's answer in `payload` settles: an acceptance or a
 * decline of a sign-in this session mirrors, for the same Connect grant and principal
 * (`sameRelayedSignIn`), asked by a child on this deployment (`localChildCallback`). A failure is
 * its asker's to retry, so it settles only its own row. Any other row keeps its own card.
 */
function answeredSignIns(
  tables: SessionView,
  payload: SubagentInteractionHookPayload,
  ownOrigin: string | undefined,
): readonly AnsweredSignIn[] {
  if (ownOrigin === undefined) return [];
  return payload.events.flatMap((event) => {
    if (event.type !== "interaction.settled") return [];
    const { interactionId, outcome } = event.data;
    if (outcome !== "accepted" && outcome !== "declined") return [];
    const answered = tables.interactions[interactionId];
    const signIn = answered?.request.signIn;
    if (
      answered?.status !== "open" ||
      answered.origin === undefined ||
      !("callId" in answered.subject) ||
      answered.subject.callId !== payload.callId ||
      signIn === undefined
    )
      return [];
    // The provider's answer, as its redirect carries it: a decline is RFC 6749 `access_denied`.
    const params: AnsweredSignIn["params"] =
      outcome === "declined" ? { error: SIGN_IN_DECLINED } : {};
    return Object.values(tables.interactions).flatMap((row) => {
      if (
        row.interactionId === interactionId ||
        row.status !== "open" ||
        row.request.signIn === undefined ||
        !sameRelayedSignIn(row.request.signIn, signIn)
      )
        return [];
      const callback = localChildCallback(row, ownOrigin);
      return callback === undefined ? [] : [{ callback, params }];
    });
  });
}

/**
 * Calls a child's sign-in callback, as Connect calls the answered one's: the child matches the
 * attempt in its own turn and settles it under its own principal, reading what Connect holds for
 * it after an acceptance. The params carry only the answer, never a code or a credential.
 */
async function settleChildSignIn({ callback, params }: AnsweredSignIn): Promise<void> {
  const payload: AuthorizationCallbackPayload = {
    kind: "authorization-callback",
    payloads: [
      {
        authorizationCallback: {
          attemptId: callback.attemptId,
          callback: { method: "GET", params },
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
