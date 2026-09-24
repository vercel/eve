import { describe, expect, it } from "vitest";

import type { TaskMessage } from "#tasks/protocol.js";
import { decodeTaskRecord } from "#tasks/record.js";
import {
  applyTaskMessage,
  cancelTask,
  evaluateTaskDeadlines,
  idleAgents,
  nextTaskWakeAt,
  pruneTaskTable,
  readTaskTable,
  startTask,
  TASK_TABLE_STATE_KEY,
  timeOutTask,
  writeTaskTable,
  type TaskTable,
} from "#tasks/table.js";

const NOW = "2026-09-24T14:02:00.000Z";
const child = { commandToken: "hook_1", kind: "workflow", runId: "run_1" } as const;

function started(
  table: TaskTable = { records: [] },
  overrides: Partial<Parameters<typeof startTask>[1]> = {},
) {
  const result = startTask(table, {
    callId: "call_1",
    kind: "workflow",
    mode: "foreground",
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
      mode: "foreground",
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

  it("starts a new generation when an idle agent is continued", () => {
    const agent = started(undefined, { kind: "agent", name: "researcher", nodeId: "n1" });
    const settled = applyTaskMessage(
      applyTaskMessage(
        agent.table,
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
    const continued = startTask(settled.table, {
      agentId: agent.record.id,
      callId: "call_2",
      kind: "agent",
      mode: "foreground",
      name: "researcher",
      nodeId: "n1",
      now: NOW,
      ownerId: "session_1",
      turnId: "turn_1",
    });
    expect(continued.kind).toBe("started");
    if (continued.kind !== "started") return;
    expect(continued.record).toMatchObject({
      callId: "call_2",
      generation: 2,
      id: agent.record.id,
      status: "working",
    });
    expect(continued.record.child).toEqual({
      continuationToken: "c",
      kind: "local",
      sessionId: "s",
    });
  });

  it("rejects unknown agents, tasks passed as agents, and mismatched agents with guidance", () => {
    const task = started();
    const unknown = startTask(task.table, {
      agentId: "nobody-123456",
      callId: "call_2",
      kind: "agent",
      mode: "foreground",
      name: "researcher",
      now: NOW,
      ownerId: "session_1",
      turnId: "turn_0",
    });
    expect(unknown).toMatchObject({ error: { code: "UNKNOWN_AGENT" }, kind: "rejected" });
    const notAgent = startTask(task.table, {
      agentId: task.record.id,
      callId: "call_3",
      kind: "agent",
      mode: "foreground",
      name: "researcher",
      now: NOW,
      ownerId: "session_1",
      turnId: "turn_0",
    });
    expect(notAgent).toMatchObject({ kind: "rejected" });
    if (notAgent.kind === "rejected") expect(notAgent.error.message).toContain("task_cancel");
  });

  it("joins the working generation when a working agent is addressed", () => {
    const agent = started(undefined, { kind: "agent", name: "researcher" });
    const steered = startTask(agent.table, {
      agentId: agent.record.id,
      callId: "call_2",
      kind: "agent",
      mode: "foreground",
      name: "researcher",
      now: NOW,
      ownerId: "session_1",
      steering: { message: "also check Plain" },
      turnId: "turn_0",
    });
    expect(steered.kind).toBe("steered");
    if (steered.kind !== "steered") return;
    expect(steered.record.generation).toBe(1);
    // No child yet, so the command is held until the child starts.
    expect(steered.record.pendingCommands).toEqual([
      { kind: "message", message: "also check Plain" },
    ]);
    const start = applyTaskMessage(
      steered.transition.table,
      { child, generation: 1, kind: "task.started", taskId: agent.record.id },
      NOW,
    );
    expect(start.effects).toEqual([
      expect.objectContaining({
        commands: [{ kind: "message", message: "also check Plain" }],
        kind: "send",
      }),
    ]);
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
    expect(first.effects).toEqual([expect.objectContaining({ kind: "settled" })]);
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
    expect(settled.effects).toHaveLength(1);
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
    const waiting = applyTaskMessage(
      task.table,
      {
        generation: 1,
        kind: "task.input",
        requests: [
          {
            action: { callId: "c", input: {}, kind: "tool-call", toolName: "t" },
            kind: "question",
            prompt: "?",
            requestId: "r",
          } as never,
        ],
        seq: 0,
        taskId: task.record.id,
      },
      NOW,
    );
    expect(waiting.table.records[0]).toMatchObject({
      clockStoppedAt: NOW,
      status: "input_required",
    });
    expect(nextTaskWakeAt(waiting.table)).toBeUndefined();
    const later = "2026-09-24T15:02:00.000Z";
    const resumed = applyTaskMessage(
      waiting.table,
      { generation: 1, kind: "task.input", requests: [], seq: 1, taskId: task.record.id },
      later,
    );
    expect(resumed.table.records[0]).toMatchObject({
      deadlineAt: "2026-09-24T15:03:00.000Z",
      status: "working",
    });
    // A stale report is ignored.
    expect(
      applyTaskMessage(
        resumed.table,
        { generation: 1, kind: "task.input", requests: [], seq: 0, taskId: task.record.id },
        later,
      ).table,
    ).toBe(resumed.table);
  });
});

describe("cancelTask", () => {
  it("records cancellation at once, holds the command until start, and confirms the child's report", () => {
    const task = started();
    const cancelled = cancelTask(task.table, task.record.id, NOW);
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.table.records[0]).toMatchObject({
      cancelConfirmBy: "2026-09-24T14:02:30.000Z",
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

  it("drops the child when a cancelled agent's session ended with its confirmation", () => {
    const agent = started(undefined, { kind: "agent", name: "researcher" });
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
    expect(confirmed.effects).toEqual([expect.objectContaining({ kind: "confirmed" })]);
    expect(confirmed.table.records[0]?.child).toBeUndefined();
  });

  it("refuses to continue an agent that never started", () => {
    const agent = started(undefined, { kind: "agent", name: "researcher" });
    const cancelled = cancelTask(agent.table, agent.record.id, NOW).table;
    const resumed = startTask(cancelled, {
      agentId: agent.record.id,
      callId: "call_2",
      kind: "agent",
      mode: "foreground",
      name: "researcher",
      now: NOW,
      ownerId: "session_1",
      turnId: "turn_1",
    });
    expect(resumed).toMatchObject({ error: { code: "AGENT_UNREACHABLE" }, kind: "rejected" });
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
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
    expect(evaluateTaskDeadlines(cancelled.table, NOW).effects).toEqual([]);
    const due = evaluateTaskDeadlines(cancelled.table, "2026-09-24T14:02:30.000Z");
    expect(due.effects).toEqual([expect.objectContaining({ child, kind: "hard-stop" })]);
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
    const due = evaluateTaskDeadlines(cancelled.table, "2026-09-24T14:02:30.000Z");
    expect(due.effects).toEqual([]);
    expect(due.table.records[0]).toMatchObject({ child: remote });
    expect(due.table.records[0]).not.toHaveProperty("cancelConfirmBy");
    expect(nextTaskWakeAt(due.table)).toBeUndefined();
  });
});

describe("deadlines", () => {
  it("asks for one reconciliation read when a working task is due, then times it out", () => {
    const task = started(undefined, { timeoutMs: 1_000 });
    expect(nextTaskWakeAt(task.table)).toBe("2026-09-24T14:02:01.000Z");
    const due = evaluateTaskDeadlines(task.table, "2026-09-24T14:02:01.000Z");
    expect(due.effects).toEqual([expect.objectContaining({ kind: "reconcile" })]);
    const timedOut = timeOutTask(due.table, task.record.id, "2026-09-24T14:02:01.000Z");
    expect(timedOut.effects[0]).toMatchObject({
      kind: "settled",
      outcome: { error: { code: "TIMED_OUT" }, status: "failed" },
    });
    expect(timedOut.table.records[0]?.status).toBe("failed");
  });
});

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
      { id: "old-aaaaaa", name: "old", reason: "unsupported version 0" },
      { reason: "not an object" },
    ]);
    expect(writeTaskTable(state, { records: [] })).toBeUndefined();
  });

  it("decodes one record without validating others", () => {
    expect(decodeTaskRecord({ ...started().record, status: "pending" })).toMatchObject({
      ok: false,
      reason: "invalid status",
    });
  });

  it("prunes delivered workflow tasks but keeps idle agents", () => {
    const task = started();
    const agent = started(task.table, { callId: "call_2", kind: "agent", name: "researcher" });
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
    table = { records: table.records.map((record) => ({ ...record, delivered: true })) };
    const pruned = pruneTaskTable(table);
    expect(pruned.records.map((record) => record.kind)).toEqual(["agent"]);
    expect(idleAgents(pruned)).toHaveLength(1);
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
