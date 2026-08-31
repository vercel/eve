import type { PreparedRuntimeActionDispatch } from "#execution/dispatch-runtime-actions-shared.js";
import { deriveRunOwner } from "#execution/tool-run/messages.js";
import { startToolRun } from "#execution/tool-run/start.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { recordToolRun } from "#harness/tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowToolCallActionRequest,
} from "#shared/action-types.js";
import { toError } from "#shared/errors.js";

const log = createLogger("execution.tool-run");

/**
 * Starts the run and records it on the session so the turn can bind its
 * result, route its requests, and cancel it. A start failure settles the call
 * with an error and records nothing, so nothing is left to cancel.
 */
export async function startWorkflowTool(input: {
  readonly action: RuntimeWorkflowToolCallActionRequest;
  readonly batchEvent: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly ownerInboxToken: string | undefined;
  readonly prepared: Pick<
    PreparedRuntimeActionDispatch,
    "auth" | "initiatorAuth" | "parentSession"
  >;
  readonly session: RuntimeSession;
}): Promise<{ readonly result?: RuntimeToolResultActionResult; readonly session: RuntimeSession }> {
  const { action, batchEvent, prepared, session } = input;
  if (input.ownerInboxToken === undefined) {
    throw new Error(
      `Workflow tool "${action.toolName}" was dispatched without the turn inbox its run reports to.`,
    );
  }
  try {
    const started = await startToolRun({
      callId: action.callId,
      input: action.input,
      owner: deriveRunOwner(input.ownerInboxToken),
      session: {
        auth: { current: prepared.auth, initiator: prepared.initiatorAuth },
        id: session.sessionId,
        parent: prepared.parentSession,
        turn: { id: batchEvent.turnId, sequence: batchEvent.sequence },
      },
      stepIndex: batchEvent.stepIndex,
      toolName: action.toolName,
      workflowId: action.workflowId,
    });
    return {
      session: recordToolRun(session, {
        callId: action.callId,
        hookToken: started.hookToken,
        runId: started.runId,
        toolName: action.toolName,
      }),
    };
  } catch (error) {
    logError(log, "workflow tool run failed to start", error, {
      callId: action.callId,
      toolName: action.toolName,
    });
    return {
      result: createRuntimeToolResultFromValue({
        callId: action.callId,
        isError: true,
        output: toError(error),
        toolName: action.toolName,
      }),
      session,
    };
  }
}
