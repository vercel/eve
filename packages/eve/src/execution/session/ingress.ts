import { randomUUID } from "node:crypto";
import { getHookByToken, type Run } from "#internal/workflow/runtime.js";
import type { AcceptedSubmission, TurnReceipt } from "#execution/turn/types.js";
import type { SessionResources } from "#execution/session/resources.js";
import { sessionDirectory } from "#execution/session/directory.js";
import { dispatchTurn } from "#execution/session/dispatch.js";
import { withWorkflowStartContext } from "#execution/workflow-start.js";
import { readSessionIdFromCommandToken } from "#execution/session-command-token.js";

export interface DispatchedSubmission {
  readonly eventId: string;
  readonly sessionId: string;
  readonly run: Run<TurnReceipt>;
}

/** Freezes the accepted delivery identity and deployment before durable dispatch. */
export function acceptSubmission(
  command: AcceptedSubmission["command"],
  eventId?: string,
): AcceptedSubmission {
  const delivery = command.kind === "send" ? command.delivery : undefined;
  return {
    command,
    eventId:
      eventId ??
      (command.kind === "send" ? (command.taskDeliveryId ?? delivery?.deliveryId) : undefined) ??
      randomUUID(),
    acceptedDeploymentId:
      delivery?.acceptedDeploymentId ?? (process.env.VERCEL_DEPLOYMENT_ID?.trim() || undefined),
  };
}

/** Dispatches an already-resolved submission without discovering mutable session state. */
export async function dispatchAcceptedSubmission(
  session: SessionResources,
  submission: AcceptedSubmission,
): Promise<DispatchedSubmission> {
  const run = await withWorkflowStartContext(() => dispatchTurn(session, submission));
  return { eventId: submission.eventId, sessionId: session.sessionId, run };
}

/** Resolves the immutable descriptor once, then starts a terminating turn candidate. */
export async function dispatchSessionCommand(
  sessionId: string,
  command: AcceptedSubmission["command"],
  eventId?: string,
): Promise<DispatchedSubmission> {
  const submission = acceptSubmission(command, eventId);
  const session = await sessionDirectory.resolveSession(sessionId);
  return await dispatchAcceptedSubmission(session, submission);
}

/** Continuation hooks are lookup addresses; accepted input is sent directly to a turn. */
export async function dispatchSessionCommandByToken(
  token: string,
  command: AcceptedSubmission["command"],
  eventId?: string,
): Promise<DispatchedSubmission> {
  const sessionId = readSessionIdFromCommandToken(token);
  if (sessionId !== undefined) return await dispatchSessionCommand(sessionId, command, eventId);
  const submission = acceptSubmission(command, eventId);
  const hook = await getHookByToken(token);
  const session = await sessionDirectory.resolveHolder(hook.runId);
  return await dispatchAcceptedSubmission(session, submission);
}
