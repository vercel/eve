import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import { taskTable, createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderTasksNote } from "#tasks/render.js";
import {
  encodeTaskCreator,
  heldTaskIds,
  holdTaskResult,
  readPendingTaskResults,
  readTaskCreator,
  sameTaskPrincipal,
  takeTaskResults,
  workingTaskIds,
} from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { applyTaskMessage, workingDetachedTaskIds } from "#tasks/table.js";

const NOW = "2026-09-24T14:05:00.000Z";
const ALICE: SessionAuthContext = {
  attributes: { team: "growth" },
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
};
const BOB: SessionAuthContext = { ...ALICE, principalId: "U-bob" };
const DONE: TaskOutcome = { output: "Reminder: stand-up at 10.", status: "completed" };

function background(id: string, auth: SessionAuthContext | null, extra: Partial<TaskRecord> = {}) {
  return createTaskRecord({
    callId: `call-${id}`,
    creator: encodeTaskCreator({ auth }),
    id,
    kind: "workflow",
    mode: "detached",
    name: id.split("-")[0]!,
    ...extra,
  });
}

/** Settles each named record in the table and holds its result, as the owner does. */
function settleAll(records: readonly TaskRecord[], ids: readonly string[]) {
  let session: { state?: SessionStateMap } = { state: taskTableState(records) };
  for (const id of ids) {
    const record = getTaskTable(session).records.find((candidate) => candidate.id === id)!;
    const applied = applyTaskMessage(
      getTaskTable(session),
      { generation: 1, kind: "task.settled", outcome: DONE, taskId: id },
      NOW,
    );
    session = { state: { ...session.state, ...taskTableState(applied.table.records) } };
    session = holdTaskResult(session, record, DONE);
  }
  return session;
}

describe("detached task results", () => {
  it("holds one result per generation and keeps its task listed until delivery", () => {
    const remind = background("remind-a1", ALICE);
    const once = settleAll([remind], ["remind-a1"]);
    const twice = holdTaskResult(once, remind, DONE);

    expect(readPendingTaskResults(twice.state)).toHaveLength(1);
    expect(renderTasksNote(getTaskTable(twice).records)).toContain('id="remind-a1"');
    expect(heldTaskIds(twice, ALICE)).toEqual(["remind-a1"]);
  });

  it("delivers a creator's results together and marks them delivered", () => {
    const session = settleAll(
      [
        background("remind-a1", ALICE),
        background("remind-a2", ALICE),
        background("remind-b1", BOB),
      ],
      ["remind-a1", "remind-b1", "remind-a2"],
    );

    const taken = takeTaskResults(session, ALICE);

    expect(taken.results.map((result) => result.taskId)).toEqual(["remind-a1", "remind-a2"]);
    expect(readPendingTaskResults(taken.session.state).map((result) => result.taskId)).toEqual([
      "remind-b1",
    ]);
    // Delivered workflow records leave the table, so the note drops them.
    expect(getTaskTable(taken.session).records.map((record) => record.id)).toEqual(["remind-b1"]);
    expect(renderTasksNote(getTaskTable(taken.session).records)).not.toContain("remind-a1");
  });

  it("never delivers one principal's results into another principal's turn", () => {
    const session = settleAll([background("remind-b1", BOB)], ["remind-b1"]);

    expect(takeTaskResults(session, ALICE).results).toEqual([]);
    expect(takeTaskResults(session, null).results).toEqual([]);
    expect(takeTaskResults(session, BOB).results.map((result) => result.taskId)).toEqual([
      "remind-b1",
    ]);
  });

  it("holds a turn on its principal's working detached tasks and undelivered results", () => {
    const records = [
      background("a-1", ALICE),
      background("b-1", ALICE, { kind: "agent", status: "input_required" }),
      background("c-1", ALICE, { status: "completed" }),
      background("d-1", ALICE, { mode: "attached" }),
      background("e-1", ALICE, { workflowCaller: { replyTo: "hook", runId: "run-1" } }),
      background("f-1", BOB),
      background("g-1", ALICE, { delivered: true, status: "cancelled" }),
    ];
    const session = { state: taskTableState(records) };

    expect(workingTaskIds(session, ALICE)).toEqual(["a-1", "b-1"]);
    expect(heldTaskIds(session, ALICE)).toEqual(["a-1", "b-1"]);
    expect(heldTaskIds(session, BOB)).toEqual(["f-1"]);
    expect(heldTaskIds(session, null)).toEqual([]);

    // A settled result holds the turn until a model step delivers it.
    const settled = settleAll([background("remind-a1", ALICE)], ["remind-a1"]);
    expect(workingTaskIds(settled, ALICE)).toEqual([]);
    expect(heldTaskIds(settled, ALICE)).toEqual(["remind-a1"]);
    expect(heldTaskIds(takeTaskResults(settled, ALICE).session, ALICE)).toEqual([]);
  });

  it("counts working and input_required detached generations toward the cap", () => {
    expect(
      workingDetachedTaskIds(
        taskTable([
          background("a-1", ALICE),
          background("b-1", ALICE, { kind: "agent", status: "input_required" }),
          background("c-1", ALICE, { status: "completed" }),
          background("d-1", ALICE, { mode: "attached" }),
          background("e-1", ALICE, { workflowCaller: { replyTo: "hook", runId: "run-1" } }),
        ]),
      ),
    ).toEqual(["a-1", "b-1"]);
  });
});

describe("task principals", () => {
  it("matches on authenticator, principal type, and principal id", () => {
    expect(sameTaskPrincipal(ALICE, { ...ALICE, attributes: {} })).toBe(true);
    expect(sameTaskPrincipal(ALICE, BOB)).toBe(false);
    expect(sameTaskPrincipal(ALICE, { ...ALICE, authenticator: "teams" })).toBe(false);
    expect(sameTaskPrincipal(ALICE, { ...ALICE, principalType: "service" })).toBe(false);
    expect(sameTaskPrincipal(null, undefined)).toBe(true);
    expect(sameTaskPrincipal(ALICE, null)).toBe(false);
  });

  it("round-trips a creator and reads an unreadable one as anonymous", () => {
    const creator = { auth: ALICE };
    expect(readTaskCreator(encodeTaskCreator(creator))).toEqual(creator);
    expect(readTaskCreator({ auth: { principalId: 7 } })).toEqual({ auth: null });
    expect(readTaskCreator(undefined)).toEqual({ auth: null });
  });
});
