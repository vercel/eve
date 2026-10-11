import { isHookConflictError } from "#execution/hook-ownership.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { failSession, runPreparedSession } from "#execution/session/program.js";
import { sessionTimeoutDeadline } from "#execution/session/timeout.js";
import { createSessionTimeoutControl } from "#execution/session/timeout-control.js";
import { recordSessionOwnerStep } from "#execution/session/handoff-steps.js";
import { completeLegacyDriverStep } from "./completion-step.js";
import { interruptLegacySessionStep } from "./interrupt-step.js";
import { prepareLegacySessionStep } from "./prepare-step.js";

/**
 * Historical dispatch name. Drivers from the former driver/turn execution
 * model start this workflow for each turn. It imports the session once —
 * persisting the conversation, claiming the current-generation inbox, and
 * interrupting pending work — then runs the current owner program. The old
 * driver stays parked as the stream anchor and hears the final result.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";
  const prepared = await prepareLegacySessionStep(rawInput);
  const { sessionId } = prepared.sessionState;
  await recordSessionOwnerStep({ sessionId });
  const inbox = createSessionInbox(sessionId);
  try {
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
  } catch (error) {
    // Another importer already owns this session; its driver will hear from it.
    if (isHookConflictError(error)) return;
    throw error;
  }
  const { sessionWritable } = prepared.input;
  let interrupted;
  try {
    await inbox.claimSessionHooks(sessionHookTokens(prepared));
    interrupted = await interruptLegacySessionStep(prepared);
  } catch (error) {
    await inbox.dispose();
    return await failSession({
      error,
      serializedContext: prepared.serializedContext,
      sessionId,
      sessionState: prepared.sessionState,
      sessionWritable,
    });
  }
  const timeoutDeadline = sessionTimeoutDeadline(prepared.sessionTimeoutMs, Date.now());
  await runPreparedSession(
    {
      anchor: {
        kind: "self",
        notify: (result) =>
          completeLegacyDriverStep({
            completionToken: prepared.input.completionToken,
            history: prepared.history,
            result,
            serializedContext: prepared.serializedContext,
            sessionState: prepared.sessionState,
            sessionWritable,
          }),
      },
      caller: undefined,
      capabilities: prepared.input.capabilities,
      deploymentId: prepared.deploymentId,
      history: interrupted.history,
      start: {
        input:
          prepared.input.delivery === undefined
            ? undefined
            : { ...prepared.input.delivery, caller: undefined },
        kind: "turn",
      },
      retention: prepared.input.retention,
      serializedContext: interrupted.serializedContext,
      sessionId,
      sessionState: interrupted.sessionState,
      sessionTimeoutControl:
        timeoutDeadline === undefined
          ? undefined
          : createSessionTimeoutControl({ deadline: timeoutDeadline, sessionId }),
      sessionTimeoutMs: prepared.sessionTimeoutMs,
      sessionTimeoutDeadline: timeoutDeadline,
      sessionWritable,
    },
    inbox,
  );
}
