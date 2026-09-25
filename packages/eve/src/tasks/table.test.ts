import { describe, expect, it } from "vitest";

import { taskTable } from "#internal/testing/task-records.js";
import type { TaskMessage } from "#tasks/protocol.js";
import { decodeTaskRecord } from "#tasks/record.js";
import {
  applyTaskMessage,
  cancelTask,
  findTask,
  isReportedLoss,
  pruneTaskTable,
  readTaskTable,
  setTaskWait,
  startTask,
  TASK_TABLE_STATE_KEY,
  writeTaskTable,
  type TaskTable,
} from "#tasks/table.js";
import { evaluateTaskDeadlines, nextTaskWakeAt, timeOutTask } from "#tasks/table-deadlines.js";
import { sendTask } from "#tasks/table-generations.js";

const NOW = "2026-09-24T14:02:00.000Z";
const child = { commandToken: "hook_1", kind: "workflow", runId: "run_1" } as const;

const QUESTION = {
  action: { callId: "c", input: {}, kind: "tool-call", toolName: "t" },
  kind: "question",
  prompt: "Which region?",
  requestId: "r",
} as const;

function inputMessage(
  taskId: string,
  input: Extract<TaskMessage, { kind: "task.input" }>["input"],
): Extract<TaskMessage, { kind: "task.input" }> {
  return { generation: 1, input, kind: "task.input", taskId };
}

/** The kinds of a transition's effects, in order. */
function kinds(transition: { readonly effects: readonly { readonly kind: string }[] }) {
  return transition.effects.map(({ kind }) => kind);
}

function started(
  table: TaskTable = taskTable([]),
  overrides: Partial<Parameters<typeof startTask>[1]> = {},
) {
  const result = startTask(table, {
    callId: "call_1",
    kind: "workflow",
    mode: "attached",
    name: "deploy",
    now: NOW,
    ownerId: "session_1",
    turnId: "turn_0",
    ...overrides,
  });
  if (result.kind !== "started") throw new Error(`unexpected ${result.kind}`);
  return result;
}

describe("startTask", () => {
  it("assigns a stable <name>-<6 base32> id before start and is idempotent by call", () => {
    const first = started();
    expect(first.record.id).toMatch(/^deploy-[0-9a-hjkmnp-tv-z]{6}$/u);
    expect(first.record).toMatchObject({ generation: 1, status: "working", delivered: false });
    expect(first.record.child).toBeUndefined();
    const replay = startTask(first.table, {
      callId: "call_1",
      kind: "workflow",
      mode: "attached",
      name: "deploy",
      now: NOW,
      ownerId: "session_1",
      turnId: "turn_0",
    });
    expect(replay).toEqual({ kind: "existing", record: first.record });
  });

  it("gives different calls different ids", () => {
    const first = started();
    const second = started(first.table, { callId: "call_2" });
    expect(second.record.id).not.toBe(first.record.id);
  });

  it("points a task at its task_wait and clears it, and a new generation drops a stale one", () => {
    const agent = started(undefined, {
      kind: "agent",
      name: "researcher",
      nodeId: "n1",
      resumable: true,
    });
    const wait = { callId: "call-w1", startedAt: NOW };
    const waited = setTaskWait(agent.table, agent.record.id, wait);
    expect(findTask(waited, agent.record.id)?.wait).toEqual(wait);
    expect(setTaskWait(waited, agent.record.id, wait)).toBe(waited);
    expect(findTask(setTaskWait(waited, agent.record.id, undefined), agent.record.id)).toEqual(
      agent.record,
    );

    const settled = applyTaskMessage(
      applyTaskMessage(
        waited,
        {
          child: { continuationToken: "c", kind: "local", sessionId: "s" },
          generation: 1,
          kind: "task.started",
          taskId: agent.record.id,
        },
        NOW,
      ).table,
      {
        generation: 1,
        kind: "task.settled",
        outcome: { output: "done", status: "completed" },
        taskId: agent.record.id,
      },
      NOW,
    );
    const continued = sendTask(settled.table, {
      callId: "call_2",
      input: { message: "again" },
      now: NOW,
      taskId: agent.record.id,
      turnId: "turn_1",
    });
    expect(continued).toMatchObject({ kind: "sent", record: { generation: 2 }, started: true });
    if (continued?.kind === "sent") expect(continued.record.wait).toBeUndefined();
  });
});

describe("applyTaskMessage", () => {
  it("records the first terminal outcome and ignores duplicates and stale generations", () => {
    const task = started();
    const settled = {
      generation: 1,
      kind: "task.settled",
      outcome: { output: { ok: true }, status: "completed" },
      taskId: task.record.id,
    } as const;
    const first = applyTaskMessage(task.table, settled, NOW);
    // Unannounced until now, the only generation starts, settles, and the task ends.
    expect(kinds(first)).toEqual(["started", "settled", "ended"]);
    expect(first.table.records[0]).toMatchObject({ announced: true, status: "completed" });
    expect(applyTaskMessage(first.table, settled, NOW).effects).toEqual([]);
    expect(
      applyTaskMessage(
        first.table,
        { ...settled, outcome: { error: { code: "X", message: "late" }, status: "failed" } },
        NOW,
      ).table,
    ).toBe(first.table);
    expect(applyTaskMessage(task.table, { ...settled, generation: 2 }, NOW).effects).toEqual([]);
  });

  it("accepts a result that arrives before task.started", () => {
    const task = started();
    const settled = applyTaskMessage(
      task.table,
      {
        generation: 1,
        kind: "task.settled",
        outcome: { output: "x", status: "completed" },
        taskId: task.record.id,
      },
      NOW,
    );
    expect(kinds(settled)).toEqual(["started", "settled", "ended"]);
    // The start was announced with the settle, so the late report announces nothing.
    const late = applyTaskMessage(
      settled.table,
      { child, generation: 1, kind: "task.started", taskId: task.record.id },
      NOW,
    );
    expect(late.table.records[0]?.child).toEqual(child);
    expect(late.effects).toEqual([]);
  });

  it("stops the deadline clock while input is required and extends it on resume", () => {
    const task = started(undefined, { timeoutMs: 60_000 });
    const input = [{ requests: [QUESTION], sequence: 3, stepIndex: 1, turnId: "turn_c" }];
    const waiting = applyTaskMessage(task.table, inputMessage(task.record.id, input), NOW);
    expect(waiting.effects).toEqual([]);
    expect(waiting.table.records[0]).toMatchObject({
      clockStoppedAt: NOW,
      input,
      status: "input_required",
    });
    expect(nextTaskWakeAt(waiting.table)).toBeUndefined();
    // A later snapshot that still waits keeps the time the clock stopped.
    const more = [...input, { ...input[0]!, sequence: 4 }];
    const still = applyTaskMessage(waiting.table, inputMessage(task.record.id, more), NOW);
    expect(still.table.records[0]).toMatchObject({ clockStoppedAt: NOW, input: more });
    const later = "2026-09-24T15:02:00.000Z";
    const resumed = applyTaskMessage(still.table, inputMessage(task.record.id, []), later);
    expect(resumed.table.records[0]).toMatchObject({
      deadlineAt: "2026-09-24T15:03:00.000Z",
      status: "working",
    });
    expect(resumed.table.records[0]).not.toHaveProperty("input");
    expect(resumed.table.records[0]).not.toHaveProperty("clockStoppedAt");
  });

  it("clears a task's surfaced input when it settles, is cancelled, or starts a new generation", () => {
    const input = [{ requests: [QUESTION], sequence: 0, stepIndex: 0, turnId: "turn_c" }];
    const agent = started(undefined, {
      kind: "agent",
      name: "researcher",
      nodeId: "n1",
      resumable: true,
    });
    const address = { continuationToken: "c", kind: "local", sessionId: "s" } as const;
    const waiting = applyTaskMessage(
      applyTaskMessage(
        agent.table,
        { child: address, generation: 1, kind: "task.started", taskId: agent.record.id },
        NOW,
      ).table,
      inputMessage(agent.record.id, input),
      NOW,
    ).table;
    const settled = applyTaskMessage(
      waiting,
      {
        generation: 1,
        kind: "task.settled",
        outcome: { output: "done", status: "completed" },
        taskId: agent.record.id,
      },
      NOW,
    ).table;
    expect(settled.records[0]).not.toHaveProperty("input");
    // A terminal task takes no more input.
    expect(applyTaskMessage(settled, inputMessage(agent.record.id, input), NOW).table).toBe(
      settled,
    );
    expect(cancelTask(waiting, agent.record.id, NOW).table.records[0]).not.toHaveProperty("input");
    expect(timeOutTask(waiting, agent.record.id, NOW).table.records[0]).not.toHaveProperty("input");
    const next = sendTask(settled, {
      callId: "call_2",
      input: { message: "Continue." },
      now: NOW,
      taskId: agent.record.id,
      turnId: "turn_1",
    });
    expect(next).toMatchObject({ kind: "sent", started: true });
    expect(next?.kind === "sent" && next.record).not.toHaveProperty("input");
  });
});

describe("cancelTask", () => {
  it("records cancellation at once, holds the command until start, and confirms the child's report", () => {
    const task = started(undefined, { resumable: true });
    const cancelled = cancelTask(task.table, task.record.id, NOW);
    // The generation starts and settles on the stream now; a resumable task stays open.
    expect(kinds(cancelled)).toEqual(["started", "cancelled"]);
    // A workflow run gets its 30-second cleanup window plus a 5-second margin.
    expect(cancelled.table.records[0]).toMatchObject({
      cancelConfirmBy: "2026-09-24T14:02:35.000Z",
      delivered: true,
      lastStatus: "Cancelled.",
      pendingCommands: [{ kind: "cancel" }],
      status: "cancelled",
    });
    const start = applyTaskMessage(
      cancelled.table,
      { child, generation: 1, kind: "task.started", taskId: task.record.id },
      NOW,
    );
    expect(start.effects).toEqual([
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
    const report = {
      generation: 1,
      kind: "task.settled" as const,
      outcome: { status: "cancelled" as const },
      taskId: task.record.id,
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 5, outputTokens: 1 },
    };
    const confirmed = applyTaskMessage(start.table, report, NOW);
    expect(confirmed.effects).toEqual([
      expect.objectContaining({ kind: "confirmed", usage: report.usage }),
    ]);
    expect(confirmed.table.records[0]?.cancelConfirmBy).toBeUndefined();
    expect(applyTaskMessage(confirmed.table, report, NOW).effects).toEqual([]);
  });

  it("ends an agent whose session ended with its cancel confirmation", () => {
    const agent = started(undefined, { kind: "agent", name: "researcher", resumable: true });
    const withChild = applyTaskMessage(
      agent.table,
      { child, generation: 1, kind: "task.started", taskId: agent.record.id },
      NOW,
    ).table;
    const cancelled = cancelTask(withChild, agent.record.id, NOW).table;
    const confirmed = applyTaskMessage(
      cancelled,
      {
        childEnded: true,
        generation: 1,
        kind: "task.settled",
        outcome: { status: "cancelled" },
        taskId: agent.record.id,
      },
      NOW,
    );
    expect(confirmed.effects.map(({ kind }) => kind)).toEqual(["confirmed", "ended"]);
    expect(confirmed.table.records[0]).toMatchObject({ ended: true, status: "cancelled" });
    expect(confirmed.table.records[0]?.child).toBeUndefined();
  });

  it("hard-stops a local child that has not confirmed within the window", () => {
    const task = started();
    const withChild = applyTaskMessage(
      task.table,
      { child, generation: 1, kind: "task.started", taskId: task.record.id },
      NOW,
    ).table;
    const cancelled = cancelTask(withChild, task.record.id, NOW);
    expect(cancelled.effects).toEqual([
      expect.objectContaining({ kind: "cancelled" }),
      expect.objectContaining({ kind: "ended" }),
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
    expect(evaluateTaskDeadlines(cancelled.table, NOW).effects).toEqual([]);
    // The run's own cleanup window has not run out yet.
    expect(evaluateTaskDeadlines(cancelled.table, "2026-09-24T14:02:30.000Z").effects).toEqual([]);
    const due = evaluateTaskDeadlines(cancelled.table, "2026-09-24T14:02:35.000Z");
    expect(due.effects).toEqual([expect.objectContaining({ child, kind: "unconfirmed" })]);
    // The stopped run takes no more work, so the record no longer names it.
    expect(due.table.records[0]).not.toHaveProperty("child");
    expect(due.table.records[0]).not.toHaveProperty("cancelConfirmBy");
    expect(evaluateTaskDeadlines(due.table, "2026-09-24T14:05:00.000Z").effects).toEqual([]);
  });

  it("stops waiting on a remote child without a hard stop", () => {
    const remote = {
      callbackBaseUrl: "https://parent.example",
      kind: "remote",
      sessionId: "remote-1",
      url: "https://remote.example",
    } as const;
    const task = started();
    const withChild = applyTaskMessage(
      task.table,
      { child: remote, generation: 1, kind: "task.started", taskId: task.record.id },
      NOW,
    ).table;
    const cancelled = cancelTask(withChild, task.record.id, NOW);
    const due = evaluateTaskDeadlines(cancelled.table, "2026-09-24T14:02:35.000Z");
    expect(due.effects).toEqual([{ kind: "unconfirmed", record: due.table.records[0] }]);
    expect(due.table.records[0]).toMatchObject({ child: remote });
    expect(due.table.records[0]).not.toHaveProperty("cancelConfirmBy");
    expect(nextTaskWakeAt(due.table)).toBeUndefined();
  });
});

describe("deadlines", () => {
  it("times out a due working task and asks its child to stop", () => {
    const task = started(undefined, { timeoutMs: 1_000 });
    const withChild = applyTaskMessage(
      task.table,
      { child, generation: 1, kind: "task.started", taskId: task.record.id },
      NOW,
    ).table;
    expect(nextTaskWakeAt(withChild)).toBe("2026-09-24T14:02:01.000Z");
    const due = evaluateTaskDeadlines(withChild, "2026-09-24T14:02:01.000Z");
    expect(due.effects).toEqual([
      expect.objectContaining({
        kind: "settled",
        outcome: {
          error: {
            code: "TIMED_OUT",
            message: "The task did not finish within 1 s and was stopped.",
          },
          status: "failed",
        },
      }),
      expect.objectContaining({ kind: "ended" }),
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
    expect(due.table.records[0]).toMatchObject({
      cancelConfirmBy: "2026-09-24T14:02:36.000Z",
      status: "failed",
    });
    // The timeout already settled it; a repeated evaluation does nothing more.
    expect(evaluateTaskDeadlines(due.table, "2026-09-24T14:02:02.000Z").effects).toEqual([]);
    expect(timeOutTask(due.table, task.record.id, NOW).effects).toEqual([]);
  });

  it("gives an agent the plain 30-second confirmation window", () => {
    const agent = started(undefined, { kind: "agent", name: "researcher" });
    expect(cancelTask(agent.table, agent.record.id, NOW).table.records[0]?.cancelConfirmBy).toBe(
      "2026-09-24T14:02:30.000Z",
    );
  });

  it("treats a limit past the last representable date as no limit", () => {
    expect(started(undefined, { timeoutMs: 1e20 }).record.deadlineAt).toBeUndefined();
    expect(started(undefined, { timeoutMs: false }).record.deadlineAt).toBeUndefined();
  });
});

/** The raw records a write stored, including any it kept unread. */
function storedRecords(state: ReturnType<typeof writeTaskTable>): unknown[] {
  const stored = state?.[TASK_TABLE_STATE_KEY] as { records?: unknown[] } | undefined;
  return stored?.records ?? [];
}

describe("persistence", () => {
  it("round-trips through session state and quarantines invalid records", () => {
    const task = started();
    const state = writeTaskTable(undefined, task.table);
    const corrupt = {
      [TASK_TABLE_STATE_KEY]: {
        records: [
          (state![TASK_TABLE_STATE_KEY] as { records: unknown[] }).records[0],
          { id: "old-aaaaaa", name: "old", v: 0 },
          "garbage",
        ],
      },
    };
    const read = readTaskTable(corrupt);
    expect(read.table.records).toEqual(task.table.records);
    expect(read.lost).toEqual([
      {
        id: "old-aaaaaa",
        name: "old",
        reason: "unsupported version 0",
        value: { id: "old-aaaaaa", name: "old", v: 0 },
      },
      { reason: "not an object", value: "garbage" },
    ]);
    expect(writeTaskTable(state, taskTable([]))).toBeUndefined();
  });

  it("keeps unreadable records through writes until their loss is reported", () => {
    const task = started();
    const unreadable = {
      callId: "call_9",
      creator: { auth: null },
      delivered: false,
      generation: 2,
      id: "old-aaaaaa",
      kind: "agent",
      mode: "detached",
      name: "old",
      v: 0,
      workflowCaller: { replyTo: "hook-1", runId: "run-1" },
    };
    const corrupt = { [TASK_TABLE_STATE_KEY]: { records: [unreadable] } };

    const written = writeTaskTable(corrupt, task.table);
    expect(storedRecords(written)).toEqual([...task.table.records, unreadable]);
    const [lost] = readTaskTable(written).lost;
    expect(lost).toMatchObject({
      callId: "call_9",
      creator: { auth: null },
      delivered: false,
      generation: 2,
      kind: "agent",
      mode: "detached",
      replyTo: "hook-1",
    });
    expect(isReportedLoss(lost!)).toBe(true);
    expect(isReportedLoss({ ...lost!, delivered: true })).toBe(false);
    expect(isReportedLoss({ reason: "not an object" })).toBe(false);

    const dropped = writeTaskTable(written, task.table, { dropLost: true });
    expect(readTaskTable(dropped)).toEqual({ lost: [], table: task.table });
  });

  it("drops a second record with a readable task's id without reporting it", () => {
    const task = started();
    const [record] = task.table.records;
    const state = { [TASK_TABLE_STATE_KEY]: { records: [record, record] } };

    const [lost] = readTaskTable(state).lost;
    expect(lost).toMatchObject({ duplicate: true, reason: "duplicate id" });
    expect(isReportedLoss(lost!)).toBe(false);
    expect(storedRecords(writeTaskTable(state, task.table))).toEqual([record]);
  });

  it("decodes a record's task_wait and rejects a malformed one", () => {
    const record = { ...started().record, wait: { callId: "call-w1", startedAt: NOW } };
    expect(decodeTaskRecord(record)).toEqual({ ok: true, record });
    for (const wait of ["call-w1", { callId: "", startedAt: NOW }, { callId: "call-w1" }]) {
      expect(decodeTaskRecord({ ...record, wait })).toMatchObject({
        ok: false,
        reason: "invalid wait",
      });
    }
  });

  it("recovers the task_wait of an unreadable record, so the wait takes the loss", () => {
    const record = { ...started().record, v: 0, wait: { callId: "call-w1", startedAt: NOW } };
    expect(decodeTaskRecord(record)).toMatchObject({
      ok: false,
      wait: { callId: "call-w1", startedAt: NOW },
    });
    expect(decodeTaskRecord({ ...record, wait: { callId: "call-w1" } })).not.toHaveProperty("wait");
  });

  it("decodes one record without validating others", () => {
    expect(decodeTaskRecord({ ...started().record, status: "pending" })).toMatchObject({
      ok: false,
      reason: "invalid status",
    });
  });

  it("decodes the input a task waits on and rejects a malformed batch", () => {
    const batch = { requests: [QUESTION], sequence: 0, stepIndex: 0, turnId: "turn_c" };
    const record = { ...started().record, input: [batch], status: "input_required" };
    expect(decodeTaskRecord(record)).toEqual({ ok: true, record });
    const dismissible = [{ ...batch, requests: [{ ...QUESTION, dismissible: true }] }];
    expect(decodeTaskRecord({ ...record, input: dismissible })).toMatchObject({ ok: true });
    for (const input of [
      batch,
      [{ ...batch, requests: [] }],
      [{ ...batch, sequence: -1 }],
      [{ ...batch, turnId: "" }],
      [{ ...batch, requests: [{ ...QUESTION, requestId: 7 }] }],
      [{ ...batch, requests: [{ ...QUESTION, dismissible: "yes" }] }],
    ]) {
      expect(decodeTaskRecord({ ...record, input })).toMatchObject({
        id: record.id,
        ok: false,
        reason: "invalid input",
      });
    }
  });

  it("prunes delivered workflow tasks but keeps idle agents", () => {
    const task = started();
    const agent = started(task.table, {
      callId: "call_2",
      kind: "agent",
      name: "researcher",
      resumable: true,
    });
    let table = agent.table;
    for (const record of table.records) {
      table = applyTaskMessage(
        table,
        {
          child:
            record.kind === "agent"
              ? { continuationToken: "c", kind: "local", sessionId: "s" }
              : child,
          generation: 1,
          kind: "task.started",
          taskId: record.id,
        },
        NOW,
      ).table;
      table = applyTaskMessage(
        table,
        {
          generation: 1,
          kind: "task.settled",
          outcome: { output: "done", status: "completed" },
          taskId: record.id,
        },
        NOW,
      ).table;
    }
    table = taskTable(table.records.map((record) => ({ ...record, delivered: true })));
    const pruned = pruneTaskTable(table);
    expect(pruned.records.map((record) => record.kind)).toEqual(["agent"]);
    expect(pruned.records[0]?.lastStatus).toBe("done");
  });
});

describe("single writer convergence", () => {
  it("converges on the same records for shuffled and duplicated message sequences", () => {
    const base = started(started().table, { callId: "call_2", name: "review" });
    const [first, second] = base.table.records;
    const messages: Exclude<TaskMessage, { kind: "task.deadline" }>[] = [];
    for (const record of [first!, second!]) {
      messages.push(
        { child, generation: 1, kind: "task.started", taskId: record.id },
        {
          generation: 1,
          kind: "task.settled",
          outcome: { output: record.id, status: "completed" },
          taskId: record.id,
        },
      );
    }
    const reference = messages.reduce(
      (table, message) => applyTaskMessage(table, message, NOW).table,
      base.table,
    );
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 200; run++) {
      const sequence = [...messages, ...messages.filter(() => random() < 0.5)].toSorted(
        () => random() - 0.5,
      );
      const table = sequence.reduce(
        (current, message) => applyTaskMessage(current, message, NOW).table,
        base.table,
      );
      expect(table).toEqual(reference);
    }
  });
});
