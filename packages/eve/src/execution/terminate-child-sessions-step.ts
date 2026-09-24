import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  resetRemoteAgentSession,
  resolveRemoteAgentStreamHeaders,
} from "#subagents/remote/dispatch.js";
import { createLogger, logError } from "#internal/logging.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { getTaskTable, readTaskTimer } from "#tasks/state.js";
import { TASK_CANCEL_CONFIRM_MS, WORKFLOW_TASK_CANCEL_CONFIRM_MS } from "#tasks/table.js";
import { armChildHardStop, cancelTaskTimer, type HardStopTarget } from "#tasks/timer-steps.js";
import { requestWorkflowSessionEnd } from "#execution/workflow-runtime.js";

const log = createLogger("execution.terminate-child-sessions");

const PARENT_SESSION_ENDED = "Parent session ended";

/**
 * Ends every child the owner has an address for when the owner session ends,
 * and stops its task timer. Each child ends the way its own session would, so
 * its finalization runs: it cancels its turn and its tasks and ends its own
 * children in turn. A local agent is asked to end its session, a remote agent
 * is retired through the authenticated session-reset route, and a working
 * workflow tool run is asked to cancel. A task whose child never reported its
 * address has nothing to stop.
 *
 * The ending owner cannot wait for its children, so it arms one last timer
 * that hard-stops each local agent or workflow run still running when its
 * cancellation window passes, as the owner's own deadline would have.
 */
export async function terminateChildSessionsStep(input: {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let session;
  try {
    session = readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read child sessions for termination", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }

  const timer = readTaskTimer(session.state);
  if (timer !== undefined) await cancelTaskTimer(timer.runId, PARENT_SESSION_ENDED);

  const records = getTaskTable(session).records.filter((record) => record.child !== undefined);
  if (records.length === 0) return;
  let bundle: CompiledBundle | undefined;
  if (records.some((record) => record.child?.kind === "remote")) {
    if (input.serializedContext === undefined) {
      throw new Error("Child finalization requires serialized runtime context.");
    }
    bundle = (await deserializeContext(input.serializedContext)).require(BundleKey);
  }

  const agents: HardStopTarget[] = [];
  const runs: HardStopTarget[] = [];
  for (const record of records) {
    const child = record.child!;
    try {
      if (child.kind === "remote") {
        const headers =
          child.credentialResolver === undefined
            ? {}
            : await resolveRemoteAgentStreamHeaders({
                bundle: bundle!,
                name: record.name,
                resolverId: child.credentialResolver,
                url: child.url,
              });
        await resetRemoteAgentSession({
          headers,
          remote: { name: record.name, url: child.url },
          sessionId: child.sessionId,
        });
        continue;
      }
      if (child.kind === "local") {
        agents.push(child);
        await requestWorkflowSessionEnd({
          reason: PARENT_SESSION_ENDED,
          sessionId: child.sessionId,
        });
        continue;
      }
      // A run the owner already cancelled still owes its confirmation.
      if (!isTerminalTaskStatus(record.status) || record.cancelConfirmBy !== undefined) {
        runs.push(child);
      }
      if (!isTerminalTaskStatus(record.status)) {
        await cancelWorkflowToolRun(
          { hookToken: child.commandToken, runId: child.runId },
          PARENT_SESSION_ENDED,
        );
      }
    } catch (error) {
      logError(log, "failed to end a child", error, {
        childKind: child.kind,
        parentSessionId: session.sessionId,
        taskId: record.id,
      });
    }
  }

  const nowMs = Date.now();
  const hardStops = [
    { targets: agents, windowMs: TASK_CANCEL_CONFIRM_MS },
    { targets: runs, windowMs: WORKFLOW_TASK_CANCEL_CONFIRM_MS },
  ];
  for (const { targets, windowMs } of hardStops) {
    if (targets.length === 0) continue;
    try {
      await armChildHardStop({
        ownerSessionId: session.sessionId,
        targets,
        wakeAt: new Date(nowMs + windowMs).toISOString(),
      });
    } catch (error) {
      logError(log, "failed to arm the hard stop for ended children", error, {
        parentSessionId: session.sessionId,
      });
    }
  }
}
