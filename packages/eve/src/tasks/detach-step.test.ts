import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTable, taskTableState } from "#internal/testing/task-records.js";
import type { TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderTasksNote } from "#tasks/render.js";
import {
  deliverableTaskResults,
  holdTaskResult,
  MAX_BACKGROUND_TASKS,
  workingBackgroundTaskIds,
} from "#tasks/results.js";
import { applyWaitedTaskChanges, detachWaitedTasksStep } from "#tasks/detach-step.js";
import { getTaskTable } from "#tasks/state.js";
import { applyTaskMessage } from "#tasks/table.js";
import { startWorkflowTask } from "#tasks/workflow-task.js";

vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn() })),
  logError: vi.fn(),
}));

const NOW = "2026-09-24T14:00:12.000Z";
const TURN = "turn_3";
const DONE: TaskOutcome = { output: "healthy", status: "completed" };

function waited(id: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return createTaskRecord({
    callId: `call-${id}`,
    creator: { auth: null },
    id,
    name: id.split("-")[0]!,
    startedAt: "2026-09-24T14:00:00.000Z",
    turnId: TURN,
    ...extra,
  });
}

const D0 = waited("d0-a1b2c3", { child: localChild("d0") });
const SRE = waited("sre-d4e5f6", { child: localChild("sre") });
const SLEEP = waited("sleep-g7h8j9", {
  child: { commandToken: "sleep-control", kind: "workflow", runId: "run-sleep" },
  kind: "workflow",
});

function localChild(name: string) {
  return { continuationToken: `${name}-token`, kind: "local" as const, sessionId: `${name}-child` };
}

function changes(overrides: Partial<Parameters<typeof applyWaitedTaskChanges>[0]["changes"]>) {
  return {
    detachCallIds: [],
    endCallIds: [],
    keepTaskIds: [],
    reason: "steer" as const,
    ...overrides,
  };
}

beforeEach(() => vi.mocked(cancelWorkflowToolRun).mockReset());

describe("applyWaitedTaskChanges", () => {
  it("moves the calls one steering message detaches into one group with receipts", () => {
    const applied = applyWaitedTaskChanges({
      changes: changes({ detachCallIds: [D0.callId, SRE.callId] }),
      now: NOW,
      table: taskTable([D0, SRE]),
      toolNames: new Map([[D0.callId, "d0_agent"]]),
      turnId: TURN,
    });

    const [d0, sre] = applied.table.records;
    expect(d0).toMatchObject({ mode: "background", status: "working" });
    expect(sre).toMatchObject({ mode: "background", status: "working" });
    expect(d0?.detachGroup).toBeDefined();
    expect(sre?.detachGroup).toBe(d0?.detachGroup);
    expect(applied.events).toEqual([
      { data: { callId: D0.callId, reason: "steer", taskId: D0.id }, type: "task.detached" },
      { data: { callId: SRE.callId, reason: "steer", taskId: SRE.id }, type: "task.detached" },
    ]);
    expect(applied.results).toEqual([
      {
        callId: D0.callId,
        kind: "tool-result",
        modelOutput: `A new message arrived, so this call moved to the background as agent ${D0.id}. Its result will arrive in a later message. Do not poll or repeat this work.`,
        output: { status: "working", taskId: D0.id },
        toolName: "d0_agent",
      },
      expect.objectContaining({
        callId: SRE.callId,
        output: { status: "working", taskId: SRE.id },
        toolName: "sre",
      }),
    ]);
    expect(applied.commands).toEqual([]);
    expect(renderTasksNote(applied.table.records)).toContain(`id="${SRE.id}"`);
  });

  it("detaches a timed call on its own, without a group", () => {
    const applied = applyWaitedTaskChanges({
      changes: changes({ detachCallIds: [SRE.callId], reason: "timeout" }),
      now: NOW,
      table: taskTable([D0, SRE]),
      toolNames: new Map(),
      turnId: TURN,
    });

    expect(applied.table.records.map(({ detachGroup, mode }) => ({ detachGroup, mode }))).toEqual([
      { detachGroup: undefined, mode: "foreground" },
      { detachGroup: undefined, mode: "background" },
    ]);
    expect(applied.results[0]?.modelOutput).toBe(
      `This call is taking a while, so it moved to the background as agent ${SRE.id}. Its result will arrive in a later message. Do not poll or repeat this work.`,
    );
    expect(applied.events).toEqual([
      { data: { callId: SRE.callId, reason: "timeout", taskId: SRE.id }, type: "task.detached" },
    ]);
  });

  it("keeps a call whose question the message dismissed, and one whose result is in flight", () => {
    const ask = waited("ask_question-k1m2n3", { kind: "workflow" });
    const settled = { ...D0, status: "completed" as const };
    const applied = applyWaitedTaskChanges({
      changes: changes({ detachCallIds: [ask.callId, D0.callId], keepTaskIds: [ask.id] }),
      now: NOW,
      table: taskTable([ask, settled]),
      toolNames: new Map(),
      turnId: TURN,
    });

    expect(applied.results).toEqual([]);
    expect(applied.events).toEqual([]);
    expect(applied.table.records.every((record) => record.mode === "foreground")).toBe(true);
  });

  it("ends a waited sleep through the cancel path and reports the time it waited", () => {
    const applied = applyWaitedTaskChanges({
      changes: changes({ endCallIds: [SLEEP.callId] }),
      now: NOW,
      table: taskTable([SLEEP]),
      toolNames: new Map(),
      turnId: TURN,
    });

    expect(applied.results).toEqual([
      {
        callId: SLEEP.callId,
        kind: "tool-result",
        modelOutput: "The sleep ended early after 12 s because a new message arrived.",
        output: { waitedSeconds: 12 },
        toolName: "sleep",
      },
    ]);
    expect(applied.table.records[0]).toMatchObject({
      cancelConfirmBy: expect.any(String),
      delivered: true,
      mode: "foreground",
      status: "cancelled",
    });
    expect(applied.events).toEqual([
      {
        data: { callId: SLEEP.callId, status: "cancelled", taskId: SLEEP.id },
        type: "task.settled",
      },
    ]);
    expect(applied.commands).toEqual([
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
  });

  it("never rejects a detach at the cap, and detached tasks count toward it", async () => {
    const running = Array.from({ length: MAX_BACKGROUND_TASKS }, (_, index) =>
      waited(`remind-${String(index).padStart(6, "0")}`, {
        callId: `call-remind-${index}`,
        kind: "workflow",
        mode: "background",
      }),
    );
    const applied = applyWaitedTaskChanges({
      changes: changes({ detachCallIds: [D0.callId] }),
      now: NOW,
      table: taskTable([...running, D0]),
      toolNames: new Map(),
      turnId: TURN,
    });
    expect(workingBackgroundTaskIds(applied.table)).toHaveLength(MAX_BACKGROUND_TASKS + 1);

    const rejected = await startWorkflowTask({
      now: NOW,
      request: {
        callId: "call-another",
        detach: true,
        input: {},
        kind: "workflow-task",
        toolName: "remind",
        workflowId: "workflow//./agent/tools/remind//execute",
      },
      session: { sessionId: "owner", state: taskTableState(applied.table.records) },
      startRun: vi.fn(),
      turnId: TURN,
    });
    expect(rejected.result).toMatchObject({
      isError: true,
      output: { code: "TOO_MANY_BACKGROUND_TASKS" },
    });
  });

  it("holds a detach group's results until every member settled", () => {
    const detached = applyWaitedTaskChanges({
      changes: changes({ detachCallIds: [D0.callId, SRE.callId] }),
      now: NOW,
      table: taskTable([D0, SRE]),
      toolNames: new Map(),
      turnId: TURN,
    });
    let session: { state?: Record<string, unknown> } = {
      state: taskTableState(detached.table.records),
    };
    const settle = (record: TaskRecord) => {
      const applied = applyTaskMessage(
        getTaskTable(session),
        { generation: 1, kind: "task.settled", outcome: DONE, taskId: record.id },
        NOW,
      );
      const settled = applied.table.records.find((candidate) => candidate.id === record.id)!;
      session = holdTaskResult(
        { state: { ...session.state, ...taskTableState(applied.table.records) } },
        settled,
        DONE,
      );
    };

    settle(D0);
    expect(deliverableTaskResults(session.state)).toEqual([]);
    settle(SRE);
    expect(deliverableTaskResults(session.state).map((entry) => entry.taskId)).toEqual([
      D0.id,
      SRE.id,
    ]);
  });
});

describe("detachWaitedTasksStep", () => {
  it("cancels an ended sleep's run and names results after the batch's tool calls", async () => {
    const update = await detachWaitedTasksStep({
      ...changes({ detachCallIds: [D0.callId], endCallIds: [SLEEP.callId] }),
      serializedContext: {},
      sessionState: ownerState(
        [D0, SLEEP],
        [
          { callId: D0.callId, toolName: "d0" },
          { callId: SLEEP.callId, toolName: "nap" },
        ],
      ),
    });

    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "sleep-control", runId: "run-sleep" },
      expect.any(String),
    );
    expect(update.results.map(({ callId, toolName }) => ({ callId, toolName }))).toEqual([
      { callId: SLEEP.callId, toolName: "nap" },
      { callId: D0.callId, toolName: "d0" },
    ]);
    expect(getTaskTable(update.sessionState.snapshot.session).records).toEqual([
      expect.objectContaining({ id: D0.id, mode: "background" }),
      expect.objectContaining({ id: SLEEP.id, status: "cancelled" }),
    ]);
  });

  it("changes nothing when every selected call already settled", async () => {
    const sessionState = ownerState([{ ...D0, status: "completed" }], []);
    const update = await detachWaitedTasksStep({
      ...changes({ detachCallIds: [D0.callId] }),
      serializedContext: {},
      sessionState,
    });
    expect(update).toMatchObject({ events: [], results: [], sessionState });
  });
});

function ownerState(
  records: readonly TaskRecord[],
  calls: readonly { readonly callId: string; readonly toolName: string }[],
): DurableSessionState {
  const base = createTestSessionState({
    emissionState: { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: TURN },
    sessionId: "owner",
  });
  return {
    ...base,
    snapshot: {
      session: {
        ...base.snapshot.session,
        state: {
          ...taskTableState(records),
          "eve.runtime.pendingCoordinationBatch": {
            event: { sequence: 3, stepIndex: 0, turnId: TURN },
            responseMessages: [],
            tasks: calls.map(({ callId, toolName }) => ({
              callId,
              input: {},
              kind: "workflow-task",
              toolName,
              workflowId: "workflow//./agent/tools/x//execute",
            })),
          },
        },
      },
    },
  };
}
