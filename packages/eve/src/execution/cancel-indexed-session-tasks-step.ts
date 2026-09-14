import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import { createLogger, logError } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

const log = createLogger("execution.cancel-indexed-session-tasks");

/** Cooperatively cancels every task currently indexed by a durable session. */
export async function cancelAllIndexedSessionTasksStep(input: {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let durable;
  try {
    durable = await readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read the session for indexed task cancellation", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }

  let entries;
  try {
    entries = getSessionTaskIndex(durable.state);
  } catch (error) {
    logError(log, "failed to read the task index", error, {
      parentSessionId: durable.sessionId,
    });
    return;
  }
  if (entries.length === 0) return;
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

  for (const entry of entries) {
    try {
      await cancelOwnedTask({
        cancelOwnedWork: cancelBackgroundAgentTask,
        entry,
        serializedContext: input.serializedContext,
        session,
      });
    } catch (error) {
      logError(log, "failed to cancel indexed task", error, {
        parentSessionId: durable.sessionId,
        taskId: entry.taskId,
      });
    }
  }
}
