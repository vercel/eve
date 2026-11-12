import { describe, expect, it } from "vitest";

import {
  isSessionStateIdleForHandoff,
  retireIdleTasksForHandoff,
} from "#execution/session/handoff-state.js";
import {
  createTask,
  findTask,
  idleTasks,
  isTaskAvailable,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  settleTaskCalls,
  writeTaskTable,
  type TaskTable,
} from "#execution/tasks/table.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { positionState, withQueuedInput } from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";

// A session hands off only with nothing open: the projection reports every open turn, and
// execution state holds queued input and retained requests.

function checkpoint(session: Pick<HarnessSession, "state">) {
  const value = createTestSessionState();
  return {
    serializedContext: {},
    sessionState: {
      ...value,
      snapshot: { session: { ...value.snapshot.session, state: session.state } },
    },
  };
}

function betweenTurns(): Pick<HarnessSession, "state"> {
  return {
    state: { ...positionState({ sequence: 1, turnId: "" }), authored: { values: [null, false] } },
  };
}

describe("handoff state inspection", () => {
  it("accepts a session between turns with opaque authored state", () => {
    expect(isSessionStateIdleForHandoff(checkpoint(betweenTurns()))).toBe(true);
  });

  it("refuses an open turn", () => {
    const open = { state: positionState({ sequence: 0, stepIndex: 0, turnId: "turn_0" }) };
    expect(isSessionStateIdleForHandoff(checkpoint(open))).toBe(false);
  });

  it.each([{ signIns: false }, { relays: { request: {} } }, { relays: null }, [], "corrupt"])(
    "refuses retained or malformed requests (%#)",
    (requests) => {
      const state = { ...betweenTurns().state, "eve.runtime.hitl.requests": requests };
      expect(isSessionStateIdleForHandoff(checkpoint({ state }))).toBe(false);
    },
  );

  it("rejects corrupt running work before a retained-request shortcut", () => {
    const state = {
      ...betweenTurns().state,
      "eve.runtime.hitl.requests": { signIns: [] },
      "eve.work": "corrupt",
    };
    expect(() => isSessionStateIdleForHandoff(checkpoint({ state }))).toThrow(
      "Corrupt running-work record",
    );
  });

  it("refuses input the session holds until it can run", () => {
    const queued = withQueuedInput(betweenTurns(), { message: "Alice asks for a summary." });
    expect(isSessionStateIdleForHandoff(checkpoint(queued))).toBe(false);
  });
});

describe("retiring idle tasks on a deployment handoff", () => {
  /** A task the model started for `name`, whose run started; idle once its call has a result. */
  function task(table: TaskTable, name: string, options: { resumable: boolean; idle: boolean }) {
    const created = createTask(table, {
      callId: `${name}-call`,
      kind: "agent",
      name,
      resumable: options.resumable,
      turnId: "turn_0",
    });
    const run = { hookToken: `${name}-control`, runId: `${name}-run` };
    let next = recordTaskRun(created.table, created.taskId, run);
    next = markTaskRunStarted(next, created.taskId, run.runId).table;
    if (options.idle)
      next = settleTaskCalls(next, {
        callIds: [`${name}-call`],
        outcome: { output: `${name} answered.`, status: "completed" },
        taskId: created.taskId,
      }).table;
    return { table: next, taskId: created.taskId };
  }

  it("retires an idle subagent, keeping its run and unread result, and lists its run to end", () => {
    const helper = task(readTaskTable(undefined), "helper", { idle: true, resumable: true });
    const reviewer = task(helper.table, "reviewer", { idle: false, resumable: true });
    const report = task(reviewer.table, "report", { idle: false, resumable: false });
    const session = writeTaskTable(betweenTurns(), report.table);

    const { checkpoint: moved, retiredTaskRuns } = retireIdleTasksForHandoff(checkpoint(session));

    expect(retiredTaskRuns).toEqual([{ hookToken: "helper-control", runId: "helper-run" }]);
    const table = readTaskTable(moved.sessionState.snapshot.session.state);
    const retired = findTask(table, helper.taskId);
    // The model starts a new helper: a call by the old id gets `UNKNOWN_TASK`.
    expect(isTaskAvailable(retired, "helper")).toBe(false);
    expect(idleTasks(table)).toEqual([]);
    expect(retired).toMatchObject({
      results: [{ output: "helper answered.", status: "completed" }],
      run: { runId: "helper-run" },
    });
    // A working task is retired by a later handoff, once it is idle.
    expect(findTask(table, reviewer.taskId)?.resumable).toBe(true);
    expect(isSessionStateIdleForHandoff(moved)).toBe(true);
  });

  it("leaves a session without idle tasks as it was", () => {
    const original = checkpoint(betweenTurns());
    expect(retireIdleTasksForHandoff(original)).toEqual({ checkpoint: original });
  });
});
