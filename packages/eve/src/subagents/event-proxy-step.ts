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
import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";
import { relay } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import { vercelConnectCallbackUrl } from "#runtime/connections/scoped-authorization.js";
import { authHookToken } from "#harness/authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";

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
  // The other askers hear a sign-in's answer before the relay commits: a delivery that fails
  // fails this step, and its retry delivers them again from the same state.
  const baseUrl = await workflowCallbackBaseUrl();
  if (baseUrl !== undefined) {
    const own = ownCallbacks(input.durableSession.sessionId, baseUrl);
    const tables = storedProjection(input.durableSession.state).view;
    await settleSignIns(
      relayedAnswers(tables, hookPayload).flatMap((answer) => signInsAnswered(tables, answer, own)),
    );
  }
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

/** An open sign-in to settle with the answer another sign-in for the same grant got. */
interface AnsweredSignIn {
  readonly callback: { readonly name: string; readonly attemptId: string; readonly token: string };
  readonly params: Readonly<Record<string, string>>;
}

/** A sign-in the person answered, and how. */
export interface SignInAnswer {
  readonly interactionId: string;
  readonly signIn: SignInChallenge;
  readonly outcome: "accepted" | "declined";
}

/** Where this session's own sign-in callbacks point: its deployment's origin and its own session. */
export interface OwnCallbacks {
  readonly origin: string;
  readonly sessionId: string;
}

/**
 * This session's own callbacks, at its workflow's callback base URL. Only a Vercel Connect sign-in
 * has a grant to share, and its callback names a loopback host `localhost`, as `eve dev` mints it.
 */
export function ownCallbacks(sessionId: string, callbackBaseUrl: string): OwnCallbacks {
  return { origin: new URL(vercelConnectCallbackUrl(callbackBaseUrl)).origin, sessionId };
}

/** This workflow's callback base URL, or `undefined` outside a workflow. */
async function workflowCallbackBaseUrl(): Promise<string | undefined> {
  const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
  const url = getWorkflowMetadata().url;
  return typeof url === "string" ? resolveWorkflowCallbackBaseUrl(url) : undefined;
}

/**
 * The callback of a sign-in asked on this deployment, by this session or a child session it
 * runs: its URL is on this deployment's origin and names the asker's inbox. A remote child's
 * callback belongs to its own deployment's world, and the parent never resumes a hook a child's
 * URL merely names.
 */
export function localSignInCallback(
  row: Pick<InteractionRow, "origin" | "request">,
  own: OwnCallbacks,
): AnsweredSignIn["callback"] | undefined {
  const callbackUrl = row.request.signIn?.callbackUrl;
  if (callbackUrl === undefined || !URL.canParse(callbackUrl)) return undefined;
  const url = new URL(callbackUrl);
  if (url.origin !== own.origin) return undefined;
  const callback = parseEveConnectionCallbackRoutePath(url.pathname);
  const asker = row.origin?.sessionId ?? own.sessionId;
  return callback?.token === authHookToken(asker) ? callback : undefined;
}

/** The answers in a child's relayed events to sign-ins this session mirrors for that child. */
function relayedAnswers(
  tables: SessionView,
  payload: SubagentInteractionHookPayload,
): readonly SignInAnswer[] {
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
    return [{ interactionId, outcome, signIn }];
  });
}

/**
 * The other open sign-ins an acceptance or a decline in `answer` settles: for the same Connect
 * grant and principal (`sameRelayedSignIn`), asked on this deployment by this session or one of
 * its children (`localSignInCallback`). A failure is its asker's to retry, so it settles only its
 * own row, and a responder's sign-in settles only through its own approval. Any other row keeps its
 * own card.
 */
export function signInsAnswered(
  tables: SessionView,
  answer: SignInAnswer,
  own: OwnCallbacks,
): readonly AnsweredSignIn[] {
  // The provider's answer, as its redirect carries it: a decline is RFC 6749 `access_denied`.
  const params: AnsweredSignIn["params"] =
    answer.outcome === "declined" ? { error: SIGN_IN_DECLINED } : {};
  return Object.values(tables.interactions).flatMap((row) => {
    if (
      row.interactionId === answer.interactionId ||
      row.status !== "open" ||
      "responseId" in row.subject ||
      row.request.signIn === undefined ||
      !sameRelayedSignIn(row.request.signIn, answer.signIn)
    )
      return [];
    const callback = localSignInCallback(row, own);
    return callback === undefined ? [] : [{ callback, params }];
  });
}

/**
 * Calls each sign-in's callback, as Connect calls the answered one's: its asker matches the
 * attempt in its own turn and settles it under its own principal, reading what Connect holds for
 * it after an acceptance. The params carry only the answer, never a code or a credential.
 */
export async function settleSignIns(answered: readonly AnsweredSignIn[]): Promise<void> {
  await Promise.all(answered.map(settleSignIn));
}

async function settleSignIn({ callback, params }: AnsweredSignIn): Promise<void> {
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
