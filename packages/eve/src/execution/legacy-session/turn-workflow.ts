import { workflowInboxTransport } from "#execution/session-inbox/workflow-transport.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { failSession, runPreparedSession, type SessionBoot } from "#execution/session/program.js";
import { workflowSessionHost } from "#execution/session/workflow-host.js";
import { createSessionTimeoutControl } from "#execution/session/timeout-control.js";
import { recordSessionOwnerStep } from "#execution/session/handoff-steps.js";
import { completeLegacyDriverStep } from "./completion-step.js";
import { interruptLegacySessionStep } from "./interrupt-step.js";
import { prepareLegacySessionStep } from "./prepare-step.js";

export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";
  const prepared = await prepareLegacySessionStep(rawInput);
  const { sessionId } = prepared.sessionState;
  await recordSessionOwnerStep({ sessionId });
  const inbox = createSessionInbox(workflowInboxTransport(sessionId));
  try {
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
  } catch (error) {
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
  const initialDeliveryKey = prepared.input.delivery?.idempotencyKey;
  const boot: SessionBoot = {
    admittedDeliveryKeys: initialDeliveryKey === undefined ? [] : [initialDeliveryKey],
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
    sessionTimeoutControl: createSessionTimeoutControl({
      sessionId,
      timeoutMs: prepared.sessionTimeoutMs,
    }),
    sessionTimeoutMs: prepared.sessionTimeoutMs,
    sessionWritable,
  };
  await runPreparedSession(boot, inbox, workflowSessionHost(boot, inbox));
}
