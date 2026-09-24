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
import type { TaskRecord } from "#tasks/record.js";
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
 * cancellation window passes, as the owner's own deadline would have. The
 * timer targets children with work in flight or an unconfirmed cancel, and
 * is armed before any request: this step may itself be the cleanup of a
 * child whose parent hard-stops it midway. The requests go out together, and
 * an idle agent whose request did not reach it gets a timer of its own.
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
  const ownerSessionId = session.sessionId;

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

  await armHardStop(ownerSessionId, hardStopTargets(records, "local"), TASK_CANCEL_CONFIRM_MS);
  await armHardStop(
    ownerSessionId,
    hardStopTargets(records, "workflow"),
    WORKFLOW_TASK_CANCEL_CONFIRM_MS,
  );

  const outcomes = await Promise.allSettled(records.map((record) => endChild(record, bundle)));
  const unreached: HardStopTarget[] = [];
  outcomes.forEach((outcome, index) => {
    const record = records[index]!;
    const child = record.child!;
    if (outcome.status === "fulfilled") return;
    logError(log, "failed to end a child", outcome.reason, {
      childKind: child.kind,
      parentSessionId: ownerSessionId,
      taskId: record.id,
    });
    // A child with work in flight is already covered by the timer above.
    if (child.kind === "local" && !hasWorkInFlight(record)) unreached.push(child);
  });
  await armHardStop(ownerSessionId, unreached, TASK_CANCEL_CONFIRM_MS);
}

/**
 * A child that may still be running work: a working task, or a cancelled one
 * whose child has not confirmed it stopped. An idle agent's session runs
 * nothing, so the request to end it is enough.
 */
function hasWorkInFlight(record: TaskRecord): boolean {
  return !isTerminalTaskStatus(record.status) || record.cancelConfirmBy !== undefined;
}

function hardStopTargets(
  records: readonly TaskRecord[],
  kind: HardStopTarget["kind"],
): HardStopTarget[] {
  return records.flatMap((record) => {
    const { child } = record;
    return (child?.kind === "local" || child?.kind === "workflow") &&
      child.kind === kind &&
      hasWorkInFlight(record)
      ? [child]
      : [];
  });
}

async function endChild(record: TaskRecord, bundle: CompiledBundle | undefined): Promise<void> {
  const child = record.child!;
  switch (child.kind) {
    case "remote": {
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
        reason: PARENT_SESSION_ENDED,
        remote: { name: record.name, url: child.url },
        sessionId: child.sessionId,
      });
      return;
    }
    case "local":
      await requestWorkflowSessionEnd({ reason: PARENT_SESSION_ENDED, sessionId: child.sessionId });
      return;
    case "workflow":
      if (isTerminalTaskStatus(record.status)) return;
      await cancelWorkflowToolRun(
        { hookToken: child.commandToken, runId: child.runId },
        PARENT_SESSION_ENDED,
      );
  }
}

async function armHardStop(
  ownerSessionId: string,
  targets: readonly HardStopTarget[],
  windowMs: number,
): Promise<void> {
  if (targets.length === 0) return;
  try {
    await armChildHardStop({
      ownerSessionId,
      targets,
      wakeAt: new Date(Date.now() + windowMs).toISOString(),
    });
  } catch (error) {
    logError(log, "failed to arm the hard stop for ended children", error, {
      parentSessionId: ownerSessionId,
    });
  }
}
