import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { taskSettledEvent } from "#tasks/events.js";
import { commandEffects, readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { readTasks } from "#tasks/read.js";
import { setTaskTable } from "#tasks/state.js";
import { cancelTask } from "#tasks/table.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";

// Owner-side cancellation: record the outcome at once, ask each started child
// to stop, and never wait for it. The timer hard-stops a child that does not
// confirm in time.

/** Which working tasks {@link cancelTasksStep} cancels. */
export type TaskCancelSelector =
  /** The waited tasks of the turn the session is running or parked in. */
  | { readonly kind: "active-turn" }
  /** Every working task: the session ends, or its delegated caller cancels it. */
  | { readonly kind: "all" }
  | { readonly kind: "workflow-run"; readonly runId: string };

/**
 * Records cancellation for every working task the selector picks, reports
 * each as settled, and asks each started child to stop. It never waits for
 * the child to confirm, and the confirmation reports nothing.
 */
export async function cancelTasksStep(input: {
  readonly selector: TaskCancelSelector;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const initial = readTasks(durable);
  let table = initial;
  const now = new Date().toISOString();
  const commands: CommandEffect[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  const turnId =
    getPendingCoordinationBatch(durable.state)?.event.turnId ??
    activeTurnId(input.sessionState.emissionState);
  // A background run's own agent calls belong to that run, not to any turn.
  const backgroundRuns = new Set(
    initial.records.flatMap((record) =>
      record.mode === "background" && record.child?.kind === "workflow" ? [record.child.runId] : [],
    ),
  );
  for (const record of initial.records) {
    const selected =
      input.selector.kind === "all" ||
      (input.selector.kind === "active-turn"
        ? record.turnId === turnId &&
          record.mode === "foreground" &&
          !backgroundRuns.has(record.workflowCaller?.runId ?? "")
        : record.workflowCaller?.runId === input.selector.runId);
    if (!selected || isTerminalTaskStatus(record.status)) continue;
    const cancelled = cancelTask(table, record.id, now);
    table = cancelled.table;
    commands.push(...commandEffects(cancelled.effects));
    events.push(taskSettledEvent({ outcome: { status: "cancelled" }, record }));
  }
  const update = { events, replies: [], results: [], serializedContext: input.serializedContext };
  if (table === initial) return { ...update, sessionState: input.sessionState };
  await runCommands(commands, await readContext(input.serializedContext));
  return {
    ...update,
    sessionState: replaceDurableSessionSnapshot({
      session: setTaskTable(durable, table),
      state: input.sessionState,
    }),
  };
}
