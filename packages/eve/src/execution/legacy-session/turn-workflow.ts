import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { createSessionInbox, claimSessionHooks } from "#execution/session-inbox/inbox.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import { failSession, runPreparedSession } from "#execution/session-program.js";
import { prepareLegacySessionStep } from "./prepare-step.js";
import { interruptLegacySessionStep } from "./interrupt-step.js";
import { completeLegacyDriverStep } from "./completion-step.js";

import type { WorkflowEntryResult } from "#execution/workflow-entry-input.js";

/** Historical dispatch name; imports once, then executes the current owner program. */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";
  const prepared = await prepareLegacySessionStep(rawInput);
  const sessionId = prepared.sessionState.sessionId;
  const inbox = createSessionInbox(sessionId);
  try {
    await inbox.claimSessionHook(prepared.hooks.stable);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }
  let result: WorkflowEntryResult = { output: "", isError: true };
  let running = false;
  try {
    await claimSessionHooks(inbox, prepared.hooks);
    const interrupted = await interruptLegacySessionStep(prepared);
    const { workflowRunId: ownerRunId } = getWorkflowMetadata();
    running = true;
    result = await runPreparedSession(
      {
        ...interrupted,
        anchorToken: `${ownerRunId}:anchor`,
        capabilities: prepared.input.capabilities,
        caller: undefined,
        initialInput:
          prepared.input.delivery?.kind === "deliver"
            ? { ...prepared.input.delivery, caller: undefined }
            : prepared.input.delivery,
        isInitialOwner: true,
        mode: prepared.input.mode,
        ownership: {
          anchorRunId: sessionId,
          sessionId,
          ownerRunId,
          deploymentId: prepared.deploymentId,
        },
        retention: prepared.input.retention,
        sessionTimeoutDeadline: prepared.sessionTimeoutDeadline,
        sessionWritable: prepared.input.parentWritable,
      },
      inbox,
    );
  } catch (error) {
    if (!running) {
      await failSession({
        error,
        sessionWritable: prepared.input.parentWritable,
        sessionId,
        mode: prepared.input.mode,
        crashCleanupState: {
          caller: undefined,
          callerResolved: true,
          lastSessionState: prepared.sessionState,
          serializedContext: prepared.serializedContext,
          terminalEmitted: false,
        },
      });
    }
    throw error;
  } finally {
    try {
      await inbox.dispose();
    } finally {
      await completeLegacyDriverStep({ prepared, result });
    }
  }
}
