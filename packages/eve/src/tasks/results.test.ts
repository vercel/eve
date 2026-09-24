import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import { taskTable, createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderTasksNote } from "#tasks/render.js";
import {
  encodeTaskCreator,
  hasDeliverableTaskResults,
  hasPendingBackgroundWork,
  holdTaskResult,
  nextTaskResultTurn,
  readPendingTaskResults,
  readTaskCreator,
  sameTaskPrincipal,
  supportsBackgroundTasks,
  takeTaskResults,
  workingBackgroundTaskIds,
} from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { applyTaskMessage, detachTasks } from "#tasks/table.js";

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
    mode: "background",
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

describe("background task results", () => {
  it("holds one result per generation and keeps its task listed until delivery", () => {
    const remind = background("remind-a1", ALICE);
    const once = settleAll([remind], ["remind-a1"]);
    const twice = holdTaskResult(once, remind, DONE);

    expect(readPendingTaskResults(twice.state)).toHaveLength(1);
    expect(renderTasksNote(getTaskTable(twice).records)).toContain('id="remind-a1"');
    expect(hasPendingBackgroundWork(twice.state)).toBe(true);
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
    expect(hasDeliverableTaskResults(session.state, ALICE)).toBe(false);
    expect(hasDeliverableTaskResults(session.state, BOB)).toBe(true);
    expect(takeTaskResults(session, null).results).toEqual([]);
  });

  it("starts the next result turn as the creator of the oldest deliverable result", () => {
    const session = settleAll(
      [background("remind-b1", BOB), background("remind-a1", ALICE)],
      ["remind-b1", "remind-a1"],
    );

    expect(readTaskCreator(nextTaskResultTurn(session.state)?.creator).auth).toEqual(BOB);
    expect(nextTaskResultTurn(takeTaskResults(session, BOB).session.state)).toEqual({
      creator: encodeTaskCreator({ auth: ALICE }),
    });
  });

  it("holds detach group members until every member settled", () => {
    const records = detachTasks(
      taskTable([
        background("sre-g1", ALICE, { mode: "foreground" }),
        background("d0-g2", ALICE, { mode: "foreground" }),
      ]),
      ["sre-g1", "d0-g2"],
      "steer-1",
    ).records;

    const partly = settleAll(records, ["sre-g1"]);
    expect(nextTaskResultTurn(partly.state)).toBeUndefined();
    expect(takeTaskResults(partly, ALICE).results).toEqual([]);
    // A held result stays listed in the note.
    expect(renderTasksNote(getTaskTable(partly).records)).toContain('id="sre-g1"');

    const settled = settleAll(records, ["sre-g1", "d0-g2"]);
    expect(takeTaskResults(settled, ALICE).results.map((result) => result.taskId)).toEqual([
      "sre-g1",
      "d0-g2",
    ]);
  });

  it("does not let a member waiting on a person hold its group", () => {
    const records = detachTasks(
      taskTable([
        background("approve-g1", ALICE, { mode: "foreground", status: "input_required" }),
        background("d0-g2", ALICE, { mode: "foreground" }),
      ]),
      ["approve-g1", "d0-g2"],
      "steer-1",
    ).records;

    const settled = settleAll(records, ["d0-g2"]);
    expect(takeTaskResults(settled, ALICE).results.map((result) => result.taskId)).toEqual([
      "d0-g2",
    ]);
    // Once answered, the member works again and holds the others until it settles.
    const answered = settleAll(
      records.map((record) =>
        record.id === "approve-g1" ? { ...record, status: "working" as const } : record,
      ),
      ["d0-g2"],
    );
    expect(takeTaskResults(answered, ALICE).results).toEqual([]);
  });

  it("keeps a held result in its group after its agent is given new work", () => {
    const records = detachTasks(
      taskTable([
        background("sre-g1", ALICE, { kind: "agent", mode: "foreground" }),
        background("d0-g2", ALICE, { mode: "foreground" }),
      ]),
      ["sre-g1", "d0-g2"],
      "steer-1",
    ).records;
    const held = settleAll(records, ["sre-g1"]);
    expect(readPendingTaskResults(held.state)[0]?.group).toBe("steer-1");

    // The next generation leaves the group, but the earlier result still waits for d0.
    const continued = {
      ...held,
      state: {
        ...held.state,
        ...taskTableState(
          getTaskTable(held).records.map((record) =>
            record.id === "sre-g1"
              ? { ...record, detachGroup: undefined, generation: 2, status: "working" as const }
              : record,
          ),
        ),
      },
    };
    expect(takeTaskResults(continued, ALICE).results).toEqual([]);
  });

  it("treats an unreadable record as outstanding until it is reported", () => {
    const lost = { "eve.taskTable": { records: [{ id: "x-1", name: "x", v: 0 }] } };
    expect(hasPendingBackgroundWork(lost)).toBe(true);
    const delivered = {
      "eve.taskTable": { records: [{ delivered: true, id: "x-1", name: "x", v: 0 }] },
    };
    expect(hasPendingBackgroundWork(delivered)).toBe(false);
  });

  it("treats a session as quiescent only when no background result is outstanding", () => {
    const working = background("remind-a1", ALICE);
    expect(hasPendingBackgroundWork(taskTableState([working]))).toBe(true);
    expect(
      hasPendingBackgroundWork(taskTableState([{ ...working, mode: "foreground" as const }])),
    ).toBe(false);
    const cancelled = { ...working, delivered: true, status: "cancelled" as const };
    expect(hasPendingBackgroundWork(taskTableState([cancelled]))).toBe(false);

    const settled = settleAll([working], ["remind-a1"]);
    expect(hasPendingBackgroundWork(settled.state)).toBe(true);
    expect(hasPendingBackgroundWork(takeTaskResults(settled, ALICE).session.state)).toBe(false);
  });

  it("counts working and input_required background tasks toward the cap", () => {
    expect(
      workingBackgroundTaskIds(
        taskTable([
          background("a-1", ALICE),
          background("b-1", ALICE, { status: "input_required" }),
          background("c-1", ALICE, { status: "completed" }),
          background("d-1", ALICE, { mode: "foreground" }),
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
    const creator = { activityRootTurnId: "turn_2", auth: ALICE };
    expect(readTaskCreator(encodeTaskCreator(creator))).toEqual(creator);
    expect(readTaskCreator({ auth: { principalId: 7 } })).toEqual({ auth: null });
    expect(readTaskCreator(undefined)).toEqual({ auth: null });
  });
});

describe("supportsBackgroundTasks", () => {
  const workflowTool = { workflowId: "workflow//deploy" };

  it("includes interactive root sessions with an agent or workflow tool", () => {
    expect(supportsBackgroundTasks({ interactiveRoot: true, tools: [workflowTool] })).toBe(true);
    expect(supportsBackgroundTasks({ interactiveRoot: true, tools: [{}] })).toBe(false);
  });

  it("includes any session with a detach: true tool, and only those elsewhere", () => {
    expect(
      supportsBackgroundTasks({
        interactiveRoot: false,
        tools: [{ ...workflowTool, detach: true }],
      }),
    ).toBe(true);
    expect(supportsBackgroundTasks({ interactiveRoot: false, tools: [workflowTool] })).toBe(false);
    expect(
      supportsBackgroundTasks({
        interactiveRoot: false,
        tools: [{ ...workflowTool, detach: { timeout: 1_000 } }],
      }),
    ).toBe(false);
  });
});
