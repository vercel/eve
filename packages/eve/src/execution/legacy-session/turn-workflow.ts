import { isHookConflictError } from "#execution/hook-ownership.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { failSession, runPreparedSession } from "#execution/session/program.js";
import { sessionTimeoutDeadline } from "#execution/session/timeout.js";
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
  const inbox = createSessionInbox(sessionId);
  try {
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
  } catch (error) {
    // Another importer already owns this session; its driver will hear from it.
    if (isHookConflictError(error)) return;
    throw error;
  }
  const { mode, sessionWritable } = prepared.input;
  let interrupted;
  try {
    await inbox.claimSessionHooks(sessionHookTokens(prepared));
    interrupted = await interruptLegacySessionStep(prepared);
  } catch (error) {
    await inbox.dispose();
    return await failSession({
      error,
      mode,
      serializedContext: prepared.serializedContext,
      sessionId,
      sessionState: prepared.sessionState,
      sessionWritable,
    });
  }
  await runPreparedSession(
    {
      anchor: {
        kind: "self",
        notify: (result) =>
          completeLegacyDriverStep({
            completionToken: prepared.input.completionToken,
            result,
            serializedContext: prepared.serializedContext,
            sessionState: prepared.sessionState,
            sessionWritable,
          }),
      },
      caller: undefined,
      capabilities: prepared.input.capabilities,
      deploymentId: prepared.deploymentId,
      initialInput:
        prepared.input.delivery === undefined
          ? undefined
          : { ...prepared.input.delivery, caller: undefined },
      awaitFirstMessage: false,
      mode,
      retention: prepared.input.retention,
      serializedContext: interrupted.serializedContext,
      sessionId,
      sessionState: interrupted.sessionState,
      sessionTimeoutMs: prepared.sessionTimeoutMs,
      sessionTimeoutDeadline: sessionTimeoutDeadline(prepared.sessionTimeoutMs, Date.now()),
      sessionWritable,
    },
    inbox,
  );
}
