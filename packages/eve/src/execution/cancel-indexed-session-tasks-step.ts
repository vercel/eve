import { recordTerminalTaskViewsStep } from "#execution/tasks/parent/hitl-proxy-steps.js";
import type { SessionStateTransition } from "#execution/session/state-cursor.js";
import type { TaskView } from "#tasks/types.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import { createLogger, logError } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getBackgroundWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

const log = createLogger("execution.cancel-indexed-session-tasks");

/** Cooperatively cancels every task currently indexed by a durable session. */
export async function cancelAllIndexedSessionTasksStep(input: {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<SessionStateTransition> {
  "use step";

  let durable;
  try {
    durable = readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read the session for indexed task cancellation", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return { sessionState: input.sessionState };
  }

  let entries;
  try {
    entries = getBackgroundWorkflowToolRuns(durable.state);
  } catch (error) {
    logError(log, "failed to read the task index", error, {
      parentSessionId: durable.sessionId,
    });
    return { sessionState: input.sessionState };
  }
  if (entries.length === 0) return { sessionState: input.sessionState };
  if (input.serializedContext === undefined) {
    throw new Error("Indexed task cancellation requires serialized runtime context.");
  }

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    durable,
    turnAgent: effectiveAgent.turnAgent,
  });

  const views: TaskView[] = [];
  for (const entry of entries) {
    try {
      const view = await cancelOwnedTask({
        cancelOwnedWork: cancelBackgroundAgentTask,
        entry,
        serializedContext: input.serializedContext,
        session,
      });
      views.push(view);
    } catch (error) {
      logError(log, "failed to cancel indexed task", error, {
        parentSessionId: durable.sessionId,
        taskId: entry.task.taskId,
      });
    }
  }
  // Session finalization closes the inbox before cancellation, so it cannot
  // rely on child notifications to record outcomes or settle activity.
  return await recordTerminalTaskViewsStep({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
    views,
  });
}
