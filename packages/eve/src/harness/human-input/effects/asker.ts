import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import {
  resolveRemoteAgentStreamHeaders,
  respondToRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import type {
  WorkflowToolRunAnswer,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import type { RelayRoute } from "#harness/human-input/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** The answers one asker receives, in the order the delivery carried them. */
export interface Forward {
  readonly route: RelayRoute;
  readonly payloads: DeliverPayload[];
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
}

/**
 * Delivers answers to whoever asked: a workflow run's own `ctx.ask()` on its
 * control hook, a remote agent over its protocol, or a child session's inbox.
 */
export async function forwardAnswers(
  forward: Forward,
  delivery: DeliverHookPayload,
  serializedContext: Record<string, unknown>,
): Promise<void> {
  const { route } = forward;
  const responses = forward.payloads.flatMap((payload) => payload.inputResponses ?? []);
  if (route.control !== undefined) {
    await sendWorkflowAskAnswers(route.control, forward, delivery);
    return;
  }
  if (route.remote !== undefined) {
    const ctx = await deserializeContext(serializedContext);
    const headers = await resolveRemoteAgentStreamHeaders({
      bundle: ctx.require(BundleKey),
      name: route.remote.name,
      resolverId: route.remote.resolverId,
      url: route.remote.url,
    });
    await respondToRemoteAgentSession({
      auth: delivery.auth,
      headers,
      remote: route.remote,
      responses,
    });
    return;
  }
  await resumeSessionInbox(route.childSessionInbox ?? route.childContinuationToken, {
    ...delivery,
    deliveryMetadata: forward.metadata.length === 0 ? undefined : forward.metadata,
    payloads: forward.payloads,
  });
}

/** Tells a run, on its control hook, that its `ctx.ask()` question is withdrawn. */
export async function withdrawQuestion(control: string, requestId: string): Promise<void> {
  const decision: WorkflowToolRunControlMessage = { kind: "withdrawn", requestId };
  await ignoreGoneTarget(resumeHook(control, decision));
}

/**
 * Sends the answers to the asking run's control hook, the same ordered inbox
 * its commands use, so an answer the session accepted before an interrupt or
 * cancel reaches the body before them. `ctx.ask()` sees who answered.
 */
async function sendWorkflowAskAnswers(
  control: string,
  forward: Forward,
  delivery: DeliverHookPayload,
): Promise<void> {
  const { auth } = delivery;
  const responder =
    auth === null || auth === undefined
      ? undefined
      : {
          authenticator: auth.authenticator,
          principalId: auth.principalId,
          principalType: auth.principalType,
        };
  for (const payload of forward.payloads) {
    for (const { optionId, requestId, text } of payload.inputResponses ?? []) {
      const response: WorkflowToolRunAnswer =
        responder === undefined
          ? { optionId, status: "answered", text }
          : { optionId, responder, status: "answered", text };
      const answer: WorkflowToolRunControlMessage = { kind: "answer", requestId, response };
      await resumeHook(control, answer);
    }
  }
}
