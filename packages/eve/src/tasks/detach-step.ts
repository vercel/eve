import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { WaitedTaskChanges } from "#tasks/detach.js";
import { taskDetachedEvent, taskSettledEvent } from "#tasks/events.js";
import { commandEffects, readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderDetachedReceipt, renderSleepEndedEarly, type TaskReceipt } from "#tasks/render.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { cancelTask, detachTasks, type TaskTable } from "#tasks/table.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";

// Owner-side changes to the calls a turn waits on, after a steering message
// or a `detach: { timeout }` timer. Detaching needs nothing from the child:
// it reports to the owner's inbox, not to the turn.

/**
 * Applies one interruption of a foreground wait: ends waited `sleep` calls
 * through the normal cancel path, moves the other selected calls to the
 * background, and returns each affected call's tool result.
 */
export async function detachWaitedTasksStep(
  input: WaitedTaskChanges & {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  },
): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const batch = getPendingCoordinationBatch(durable.state);
  const table = getTaskTable(durable);
  const applied = applyWaitedTaskChanges({
    changes: input,
    now: new Date().toISOString(),
    table,
    toolNames: new Map(batch?.tasks.map((request) => [request.callId, request.toolName])),
    turnId: batch?.event.turnId || activeTurnId(input.sessionState.emissionState),
  });
  const update = {
    events: applied.events,
    replies: [],
    results: applied.results,
    serializedContext: input.serializedContext,
  };
  if (applied.table === table) return { ...update, sessionState: input.sessionState };
  await runCommands(applied.commands, await readContext(input.serializedContext));
  return {
    ...update,
    sessionState: replaceDurableSessionSnapshot({
      session: setTaskTable(durable, applied.table),
      state: input.sessionState,
    }),
  };
}

/**
 * The pure transition behind {@link detachWaitedTasksStep}. A call whose
 * task already settled, or that no longer waits, is left alone: its result
 * is on its way to the turn.
 */
export function applyWaitedTaskChanges(input: {
  readonly changes: WaitedTaskChanges;
  readonly now: string;
  readonly table: TaskTable;
  /** Tool name of each waited call, so every tool result answers its own call. */
  readonly toolNames: ReadonlyMap<string, string>;
  readonly turnId: string;
}): {
  readonly table: TaskTable;
  readonly commands: readonly CommandEffect[];
  readonly events: readonly UnstampedMessageStreamEvent[];
  readonly results: readonly RuntimeToolResultActionResult[];
} {
  const { changes, now, turnId } = input;
  const waited = (callId: string): TaskRecord | undefined =>
    input.table.records.find(
      (record) =>
        record.callId === callId &&
        record.turnId === turnId &&
        record.mode === "foreground" &&
        record.workflowCaller === undefined &&
        !isTerminalTaskStatus(record.status),
    );
  const toolName = (record: TaskRecord) => input.toolNames.get(record.callId) ?? record.name;
  let table = input.table;
  const commands: CommandEffect[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  const results: RuntimeToolResultActionResult[] = [];

  for (const record of changes.endCallIds.flatMap((callId) => waited(callId) ?? [])) {
    const cancelled = cancelTask(table, record.id, now);
    table = cancelled.table;
    commands.push(...commandEffects(cancelled.effects));
    events.push(taskSettledEvent({ outcome: { status: "cancelled" }, record }));
    const waitedMs = Math.max(0, Date.parse(now) - Date.parse(record.startedAt));
    results.push({
      callId: record.callId,
      kind: "tool-result",
      modelOutput: renderSleepEndedEarly(waitedMs),
      output: { waitedSeconds: waitedMs / 1000 },
      toolName: toolName(record),
    });
  }

  const detached = changes.detachCallIds
    .flatMap((callId) => waited(callId) ?? [])
    .filter((record) => !changes.keepTaskIds.includes(record.id));
  const [first] = detached;
  if (first !== undefined) {
    // Tasks one steering message detaches deliver their results together; a
    // timer detaches its call on its own.
    const group =
      changes.reason === "steer"
        ? `${first.turnId}/${changes.groupCallId ?? first.callId}`
        : undefined;
    table = detachTasks(
      table,
      detached.map((record) => record.id),
      group,
    );
    for (const record of detached) {
      events.push(taskDetachedEvent({ reason: changes.reason, record }));
      const receipt: TaskReceipt = { status: "working", taskId: record.id };
      results.push({
        callId: record.callId,
        kind: "tool-result",
        modelOutput: renderDetachedReceipt(record, changes.reason),
        output: { ...receipt },
        toolName: toolName(record),
      });
    }
  }
  return { commands, events, results, table };
}
