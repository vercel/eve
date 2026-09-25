import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { createTaskRecord, taskTable } from "#internal/testing/task-records.js";
import { checkSend, MAX_RETAINED_IDLE_TASKS, retireIdleTasks } from "#tasks/owner-calls.js";
import { findTask, MAX_UNREAD_SENDS, MAX_WORKING_TASKS, pruneTaskTable } from "#tasks/table.js";
import { encodeTaskCreator } from "#tasks/results.js";

const NOW = "2026-09-24T14:02:00.000Z";

function principal(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}

describe("retireIdleTasks", () => {
  const idle = (index: number, starter: SessionAuthContext | null = null) =>
    createTaskRecord({
      callId: `call-${String(index)}`,
      child: {
        continuationToken: `t${String(index)}`,
        kind: "local",
        sessionId: `s${String(index)}`,
      },
      creator: encodeTaskCreator({ auth: starter }),
      delivered: true,
      id: `research-${String(index).padStart(6, "0")}`,
      startedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      status: "completed",
    });

  it("counts idle resumable workflow tasks with idle agents, and never working ones", () => {
    const agents = Array.from({ length: MAX_RETAINED_IDLE_TASKS }, (_, index) => idle(index + 1));
    const notes = createTaskRecord({
      child: { commandToken: "cmd", kind: "workflow", runId: "run" },
      delivered: true,
      id: "release_notes-000000",
      kind: "workflow",
      name: "release_notes",
      resumable: true,
      startedAt: NOW,
      status: "completed",
    });
    const { retired } = retireIdleTasks(taskTable([notes, ...agents]), null, NOW);
    expect(retired.map((record) => record.id)).toEqual([notes.id]);
  });

  it("keeps the most recently started idle agents and retires the rest, oldest first", () => {
    const agents = Array.from({ length: MAX_RETAINED_IDLE_TASKS + 2 }, (_, index) => idle(index));
    const working = createTaskRecord({ id: "research-working", startedAt: NOW });

    const { effects, retired, table } = retireIdleTasks(taskTable([...agents, working]), null, NOW);

    expect(retired.map((record) => record.id)).toEqual([agents[0]!.id, agents[1]!.id]);
    // Each retired task ends like any other, keeping its child only for the owner to stop.
    expect(retired[0]!.child).toBeDefined();
    expect(effects).toEqual([
      { kind: "ended", record: expect.objectContaining({ ended: true, id: agents[0]!.id }) },
      { kind: "ended", record: expect.objectContaining({ ended: true, id: agents[1]!.id }) },
    ]);
    expect(findTask(table, agents[0]!.id)?.child).toBeUndefined();
    const kept = pruneTaskTable(table).records;
    expect(kept).toHaveLength(MAX_RETAINED_IDLE_TASKS + 1);
    expect(kept).toContainEqual(working);
  });

  it("retires the calling principal's own idle agents before anyone else's", () => {
    const alice = principal("alice");
    const bob = principal("bob");
    // Bob's agents are the oldest, but Alice's new agent retires one of her own.
    const agents = Array.from({ length: MAX_RETAINED_IDLE_TASKS + 1 }, (_, index) =>
      idle(index, index < 10 ? bob : alice),
    );

    const { retired } = retireIdleTasks(taskTable(agents), alice, NOW);

    expect(retired.map((record) => record.id)).toEqual([agents[10]!.id]);
  });

  it("retires another principal's agents once the caller has none idle", () => {
    const alice = principal("alice");
    const agents = Array.from({ length: MAX_RETAINED_IDLE_TASKS + 1 }, (_, index) =>
      idle(index, principal("bob")),
    );

    const { retired } = retireIdleTasks(taskTable(agents), alice, NOW);

    expect(retired.map((record) => record.id)).toEqual([agents[0]!.id]);
  });

  it("leaves a table within the limit untouched", () => {
    const table = taskTable([idle(0), idle(1)]);
    expect(retireIdleTasks(table, null, NOW)).toEqual({ effects: [], retired: [], table });
  });
});

describe("checkSend", () => {
  const alice = principal("alice");
  const agent = createTaskRecord({
    child: { continuationToken: "t", kind: "local", sessionId: "s" },
    creator: encodeTaskCreator({ auth: alice }),
    delivered: true,
    id: "research-7k2m9q",
    mode: "detached",
    status: "completed",
  });
  const check = (
    records: readonly ReturnType<typeof createTaskRecord>[],
    overrides: Partial<Parameters<typeof checkSend>[0]> = {},
  ) =>
    checkSend({
      caller: alice,
      table: taskTable(records),
      taskId: agent.id,
      toolName: "research",
      ...overrides,
    });

  it("accepts a send from the task's own principal to its own tool", () => {
    expect(check([agent])).toBeUndefined();
    expect(check([{ ...agent, status: "working" }])).toBeUndefined();
  });

  it("refuses a task the session does not have, one that ended, and one that cannot take input", () => {
    expect(check([])).toMatchObject({
      code: "UNKNOWN_TASK",
      message: expect.stringContaining("calling research without taskId"),
    });
    expect(check([{ ...agent, ended: true }])).toMatchObject({ code: "UNKNOWN_TASK" });
    expect(check([{ ...agent, resumable: undefined }])).toMatchObject({ code: "UNKNOWN_TASK" });
    const neverStarted = { ...agent, child: undefined };
    expect(check([neverStarted])).toMatchObject({ code: "UNKNOWN_TASK" });
    // An agent still starting holds the send until it reports.
    expect(check([{ ...neverStarted, status: "working" }])).toBeUndefined();
  });

  it("refuses another tool's task and another principal's", () => {
    expect(check([agent], { toolName: "reviewer" })).toMatchObject({
      code: "TASK_MISMATCH",
      message: 'Task "research-7k2m9q" belongs to research; call research with it.',
    });
    expect(check([agent], { caller: principal("bob") })).toMatchObject({
      code: "TASK_OTHER_PRINCIPAL",
    });
    // Another principal does not learn which tool the task belongs to.
    expect(check([agent], { caller: principal("bob"), toolName: "reviewer" })).toMatchObject({
      code: "TASK_OTHER_PRINCIPAL",
    });
  });

  it("refuses a send to a task that already holds the most unread input it may", () => {
    const sends = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        callId: `send-${String(index)}`,
        seq: index + 1,
        turnId: "turn-1",
      }));
    const working = { ...agent, status: "working" as const };
    expect(check([{ ...working, sends: sends(MAX_UNREAD_SENDS - 1) }])).toBeUndefined();
    expect(check([{ ...working, sends: sends(MAX_UNREAD_SENDS) }])).toEqual({
      code: "TASK_BUSY",
      message: `Task "research-7k2m9q" already has ${MAX_UNREAD_SENDS} inputs it has not read, so it can't take more yet. Wait for its next result with task_wait, then call research with its taskId again.`,
    });
    // Sends held for an agent still starting count the same, so its held commands stay bounded.
    const starting = { ...working, child: undefined, sends: sends(MAX_UNREAD_SENDS) };
    expect(check([starting])).toMatchObject({ code: "TASK_BUSY" });
  });

  it("refuses work a workflow body awaits, and a body's send to a working agent", () => {
    const owned = {
      ...agent,
      status: "working" as const,
      workflowCaller: { replyTo: "hook", runId: "run" },
    };
    expect(check([owned])).toMatchObject({ code: "TASK_BUSY" });
    expect(check([{ ...agent, status: "working" }], { fromWorkflow: true })).toMatchObject({
      code: "TASK_BUSY",
    });
    expect(check([agent], { fromWorkflow: true })).toBeUndefined();
  });

  it("counts a send to an idle task against the working-task cap, but not one to a working task", () => {
    const busy = Array.from({ length: MAX_WORKING_TASKS }, (_, index) =>
      createTaskRecord({
        callId: `call-busy-${String(index)}`,
        id: `lookup-${String(index).padStart(6, "0")}`,
        kind: "workflow",
        mode: "detached",
        name: "lookup",
      }),
    );
    expect(check([...busy, agent])).toMatchObject({ code: "TOO_MANY_TASKS" });
    expect(check([...busy, { ...agent, status: "working" }])).toBeUndefined();
  });
});
