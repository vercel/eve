import { describe, expect, it } from "vitest";

import type { TaskMessage } from "#tasks/protocol.js";
import {
  applyTaskMessage,
  cancelTask,
  findTask,
  markTaskDelivered,
  MAX_UNREAD_SENDS,
  pruneTaskTable,
  startTask,
  type TaskEffect,
  type TaskTable,
} from "#tasks/table.js";
import { taskTable } from "#internal/testing/task-records.js";
import { adoptWorkflowRun, sendTask, withdrawSend } from "#tasks/table-generations.js";

// Resumable tasks: each send starts or joins a generation, the owner
// attributes generations from the sends a child reads in order, and a task
// ends once, after every send it never read has its own result.

const NOW = "2026-09-24T14:00:00.000Z";
const RUN = { commandToken: "cmd", kind: "workflow", runId: "run-1" } as const;
const SESSION = { continuationToken: "c", kind: "local", sessionId: "child" } as const;

type ChildMessage = Exclude<TaskMessage, { kind: "task.deadline" }>;

function startResumable(kind: "agent" | "workflow"): { table: TaskTable; taskId: string } {
  const start = startTask(taskTable([]), {
    callId: "call-1",
    kind,
    mode: "detached",
    name: kind === "agent" ? "researcher" : "release_notes",
    now: NOW,
    ownerId: "session-1",
    resumable: true,
    turnId: "turn-1",
  });
  if (start.kind !== "started") throw new Error(start.kind);
  const adopted = applyTaskMessage(
    start.table,
    {
      child: kind === "agent" ? SESSION : RUN,
      generation: 1,
      kind: "task.started",
      taskId: start.record.id,
    },
    NOW,
  );
  return { table: adopted.table, taskId: start.record.id };
}

/** The lifecycle events and commands an owner publishes and sends from effects. */
function lifecycle(effects: readonly TaskEffect[]): string[] {
  return effects.flatMap((effect) => {
    const { record } = effect;
    const where = `g${record.generation} ${record.callId}`;
    switch (effect.kind) {
      case "started":
        return [`started ${where}`];
      case "settled":
        return [`settled ${where} ${effect.outcome.status}`];
      case "cancelled":
        return [`started ${where}`, `settled ${where} cancelled`];
      case "ended":
        return ["ended"];
      case "send":
        return effect.commands.map((command) =>
          command.kind === "input" ? `input #${command.seq}` : command.kind,
        );
      default:
        return [];
    }
  });
}

/** §4.7: one started then one settled per generation, one ended after the last settled. */
function expectLifecycle(events: readonly string[]): void {
  let open: string | undefined;
  let ended = false;
  for (const event of events) {
    const [kind, generation] = event.split(" ");
    if (kind === "input" || kind === "cancel") continue;
    expect(ended, `${event} after ended`).toBe(false);
    if (kind === "started") {
      expect(open, `${event} while a generation is open`).toBeUndefined();
      open = generation;
    } else if (kind === "settled") {
      expect(open, `${event} without started`).toBe(generation);
      open = undefined;
    } else if (kind === "ended") {
      expect(open, `${event} with an open generation`).toBeUndefined();
      ended = true;
    }
  }
}

function driver(kind: "agent" | "workflow") {
  const task = startResumable(kind);
  let table = task.table;
  const events = [`started g1 call-1`];
  const apply = (message: ChildMessage) => {
    const applied = applyTaskMessage(table, message, NOW);
    table = applied.table;
    events.push(...lifecycle(applied.effects));
  };
  const send = (seq: number, turnId = "turn-1") => {
    const sent = sendTask(table, {
      callId: `send-${seq}`,
      input: { request: `r${seq}` },
      now: NOW,
      taskId: task.taskId,
      turnId,
    });
    if (sent?.kind !== "sent") throw new Error(JSON.stringify(sent));
    table = sent.table;
    if (sent.started) events.push(`started g${sent.record.generation} ${sent.record.callId}`);
    events.push(...lifecycle(sent.effects));
    return sent;
  };
  const reply = (generation: number, read?: number[], steers?: number) =>
    apply({
      generation,
      kind: "task.settled",
      outcome: { output: `v${generation}`, status: "completed" },
      read,
      steers,
      taskId: task.taskId,
    });
  return {
    apply,
    events,
    record: () => findTask(table, task.taskId)!,
    reply,
    send,
    table: () => table,
    taskId: task.taskId,
  };
}

describe("resumable workflow tasks", () => {
  it("settles two sends as two more generations, idles between them, and ends once", () => {
    const task = driver("workflow");
    task.reply(1);
    expect(task.record()).toMatchObject({ child: RUN, generation: 1, status: "completed" });
    // Idle: pruning keeps it once its result is delivered.
    const delivered = markTaskDelivered(task.table(), task.taskId, 1);
    expect(findTask(pruneTaskTable(delivered), task.taskId)).toBeDefined();

    const first = task.send(1, "turn-2");
    expect(first.record).toMatchObject({ callId: "send-1", generation: 2, turnId: "turn-2" });
    task.apply({ generation: 2, kind: "task.started", send: 1, taskId: task.taskId });
    task.reply(2);
    task.send(2);
    task.apply({ generation: 3, kind: "task.started", send: 2, taskId: task.taskId });
    task.reply(3);
    task.apply({ kind: "task.ended", taskId: task.taskId, unread: [] });

    expect(task.events).toEqual([
      "started g1 call-1",
      "settled g1 call-1 completed",
      "started g2 send-1",
      "input #1",
      "settled g2 send-1 completed",
      "started g3 send-2",
      "input #2",
      "settled g3 send-2 completed",
      "ended",
    ]);
    expectLifecycle(task.events);
    expect(task.record()).toMatchObject({ ended: true });
    expect(task.record().child).toBeUndefined();
    // An ended task takes no send, and is pruned once its results are delivered.
    expect(
      sendTask(task.table(), {
        callId: "late",
        input: {},
        now: NOW,
        taskId: task.taskId,
        turnId: "turn-3",
      }),
    ).toBeUndefined();
    expect(pruneTaskTable(markTaskDelivered(task.table(), task.taskId, 3)).records).toEqual([]);
  });

  it("ignores a replayed send", () => {
    const task = driver("workflow");
    task.send(1);
    const replay = sendTask(task.table(), {
      callId: "send-1",
      input: { request: "r1" },
      now: NOW,
      taskId: task.taskId,
      turnId: "turn-1",
    });
    expect(replay).toEqual({ kind: "existing", record: task.record() });
    expect(task.record().lastSeq).toBe(1);
  });

  it("joins a send the body reads to the current work, and starts the next generation with one it did not", () => {
    const task = driver("workflow");
    task.send(1);
    task.reply(1, [1]);
    expect(task.record().sends).toBeUndefined();
    expect(task.events.slice(-2)).toEqual(["input #1", "settled g1 call-1 completed"]);

    task.send(2, "turn-2");
    task.send(3, "turn-3");
    task.reply(2, []);
    // The owner derives the next generation from the child's in-order reads: no round trip.
    expect(task.events.slice(-2)).toEqual(["settled g2 send-2 completed", "started g3 send-3"]);
    expect(task.record()).toMatchObject({ startedBy: 3, turnId: "turn-3" });
    expect(task.record().sends).toBeUndefined();
    expectLifecycle(task.events);
  });

  it("gives every send the body never read a generation that fails at once, then ends", () => {
    const task = driver("workflow");
    task.send(1);
    task.send(2);
    task.reply(1);
    task.apply({ kind: "task.ended", taskId: task.taskId, unread: [1, 2] });
    expect(task.events.slice(1)).toEqual([
      "input #1",
      "input #2",
      "settled g1 call-1 completed",
      "started g2 send-1",
      "settled g2 send-1 failed",
      "started g3 send-2",
      "settled g3 send-2 failed",
      "ended",
    ]);
    expectLifecycle(task.events);
    const applied = applyTaskMessage(
      task.table(),
      { kind: "task.ended", taskId: task.taskId, unread: [] },
      NOW,
    );
    expect(applied.effects).toEqual([]);
  });

  it("cancels a generation and its queued sends, then takes new work; the end stops the task", () => {
    const task = driver("workflow");
    task.send(1);
    const cancelled = cancelTask(task.table(), task.taskId, NOW);
    expect(lifecycle(cancelled.effects)).toEqual(["cancel"]);
    expect(findTask(cancelled.table, task.taskId)).toMatchObject({
      sends: [{ cancelled: true, seq: 1 }],
      status: "cancelled",
    });
    const confirm = applyTaskMessage(
      cancelled.table,
      {
        generation: 1,
        kind: "task.settled",
        outcome: { status: "cancelled" },
        taskId: task.taskId,
      },
      NOW,
    );
    // The run settles the cancelled send as its own generation; the owner waits for that report.
    expect(lifecycle(confirm.effects)).toEqual([
      "started g2 send-1",
      "settled g2 send-1 cancelled",
    ]);
    expect(findTask(confirm.table, task.taskId)).toMatchObject({
      cancelConfirmBy: expect.any(String),
      delivered: true,
      generation: 2,
    });
    const idle = applyTaskMessage(
      confirm.table,
      {
        generation: 2,
        kind: "task.settled",
        outcome: { status: "cancelled" },
        taskId: task.taskId,
      },
      NOW,
    );
    expect(findTask(idle.table, task.taskId)).toMatchObject({ generation: 2, status: "cancelled" });
    expect(findTask(idle.table, task.taskId)?.cancelConfirmBy).toBeUndefined();

    const next = sendTask(idle.table, {
      callId: "send-2",
      input: { request: "again" },
      now: NOW,
      taskId: task.taskId,
      turnId: "turn-2",
    });
    expect(next).toMatchObject({ kind: "sent", record: { generation: 3 }, started: true });
    if (next?.kind !== "sent") return;
    const ended = applyTaskMessage(
      next.table,
      { kind: "task.ended", taskId: task.taskId, unread: [2] },
      NOW,
    );
    expect(lifecycle(ended.effects)).toEqual(["settled g3 send-2 failed", "ended"]);
    expect(ended.effects[0]).toMatchObject({
      outcome: { error: { message: "The task ended before it read this input." } },
    });
  });

  it("takes back a send whose delivery failed, keeps its call, and never reuses its number", () => {
    const task = driver("workflow");
    task.send(1);
    const second = task.send(2);
    const withdrawn = withdrawSend(task.table(), task.taskId, second.send);
    expect(findTask(withdrawn, task.taskId)).toMatchObject({
      lastSeq: 2,
      sends: [{ callId: "send-1", seq: 1, turnId: "turn-1" }],
      undelivered: [{ callId: "send-2", seq: 2, turnId: "turn-1" }],
    });
    // A send that would have started an idle task is taken back from the table before it.
    const other = driver("workflow");
    other.send(1);
    other.send(2);
    other.reply(1, [1, 2]);
    const idle = other.table();
    const started = sendTask(idle, {
      callId: "send-3",
      input: {},
      now: NOW,
      taskId: other.taskId,
      turnId: "turn-2",
    });
    if (started?.kind !== "sent") throw new Error("not sent");
    const retracted = findTask(withdrawSend(idle, other.taskId, started.send), other.taskId)!;
    expect(retracted).toMatchObject({ generation: 1, lastSeq: 3, status: "completed" });
    expect(retracted.undelivered?.map((send) => send.seq)).toEqual([3]);
    const next = sendTask(withdrawSend(idle, other.taskId, started.send), {
      callId: "send-4",
      input: {},
      now: NOW,
      taskId: other.taskId,
      turnId: "turn-2",
    });
    expect(next).toMatchObject({ send: { seq: 4 } });
  });

  it("keeps an agent's failed send out of the list its steering count maps onto", () => {
    const task = driver("agent");
    const sent = task.send(1);
    const withdrawn = findTask(withdrawSend(task.table(), task.taskId, sent.send), task.taskId)!;
    expect(withdrawn.sends).toBeUndefined();
    expect(withdrawn.undelivered).toBeUndefined();
    expect(withdrawn.lastSeq).toBe(1);
  });

  it("bounds the undelivered sends it keeps", () => {
    const task = driver("workflow");
    let table = task.table();
    for (let seq = 1; seq <= MAX_UNREAD_SENDS + 3; seq++) {
      table = withdrawSend(table, task.taskId, { callId: `send-${seq}`, seq, turnId: "turn-1" });
    }
    const undelivered = findTask(table, task.taskId)!.undelivered!;
    expect(undelivered).toHaveLength(MAX_UNREAD_SENDS);
    expect(undelivered[0]!.seq).toBe(4);
  });
});

describe("a workflow run's report of the generation it started", () => {
  function started(generation: number, send: number): ChildMessage {
    return { generation, kind: "task.started", send, taskId: "" };
  }

  it("confirms the owner's own attribution", () => {
    const task = driver("workflow");
    task.reply(1);
    task.send(1, "turn-2");
    const before = task.table();
    task.apply({ ...started(2, 1), taskId: task.taskId });
    expect(task.table()).toBe(before);
  });

  it("adopts a generation a failed delivery started, so its reply settles it", () => {
    const task = driver("workflow");
    task.reply(1);
    const idle = task.table();
    // The delivery failed, but the run took the input before the call did.
    const failed = sendTask(idle, {
      callId: "send-1",
      input: {},
      now: NOW,
      taskId: task.taskId,
      turnId: "turn-2",
    });
    if (failed?.kind !== "sent") throw new Error("not sent");
    const withdrawn = withdrawSend(idle, task.taskId, failed.send);
    const adopted = applyTaskMessage(withdrawn, { ...started(2, 1), taskId: task.taskId }, NOW);
    expect(lifecycle(adopted.effects)).toEqual(["started g2 send-1"]);
    expect(findTask(adopted.table, task.taskId)).toMatchObject({
      callId: "send-1",
      generation: 2,
      startedBy: 1,
      status: "working",
      turnId: "turn-2",
    });
    expect(findTask(adopted.table, task.taskId)!.undelivered).toBeUndefined();
    const replied = applyTaskMessage(
      adopted.table,
      {
        generation: 2,
        kind: "task.settled",
        outcome: { output: "v2", status: "completed" },
        read: [],
        taskId: task.taskId,
      },
      NOW,
    );
    expect(lifecycle(replied.effects)).toEqual(["settled g2 send-1 completed"]);
  });

  it("gives a retried send back to the queue when the run started the failed one first", () => {
    const task = driver("workflow");
    task.reply(1);
    const idle = markTaskDelivered(task.table(), task.taskId, 1);
    const failed = sendTask(idle, {
      callId: "send-1",
      input: {},
      now: NOW,
      taskId: task.taskId,
      turnId: "turn-2",
    });
    if (failed?.kind !== "sent") throw new Error("not sent");
    const withdrawn = withdrawSend(idle, task.taskId, failed.send);
    // The model retries; the owner starts generation 2 for the retry.
    const retry = sendTask(withdrawn, {
      callId: "send-2",
      input: {},
      now: NOW,
      taskId: task.taskId,
      turnId: "turn-2",
    });
    if (retry?.kind !== "sent") throw new Error("not sent");
    expect(retry.record).toMatchObject({ callId: "send-2", generation: 2, startedBy: 2 });

    const adopted = applyTaskMessage(retry.table, { ...started(2, 1), taskId: task.taskId }, NOW);
    expect(adopted.effects).toEqual([]);
    expect(findTask(adopted.table, task.taskId)).toMatchObject({
      callId: "send-1",
      generation: 2,
      sends: [{ callId: "send-2", seq: 2, turnId: "turn-2" }],
      startedBy: 1,
    });
    const replied = applyTaskMessage(
      adopted.table,
      {
        generation: 2,
        kind: "task.settled",
        outcome: { output: "v2", status: "completed" },
        read: [],
        taskId: task.taskId,
      },
      NOW,
    );
    expect(lifecycle(replied.effects)).toEqual([
      "settled g2 send-1 completed",
      "started g3 send-2",
    ]);
    // The run starts generation 3 for the retry, as the owner expects.
    const confirmed = applyTaskMessage(
      replied.table,
      { ...started(3, 2), taskId: task.taskId },
      NOW,
    );
    expect(confirmed.table).toBe(replied.table);
  });

  it("settles a generation whose reply was lost once the run starts the next one", () => {
    const task = driver("workflow");
    task.send(1);
    task.send(2);
    // The run read send 1 during generation 1 and replied, but the reply never arrived.
    task.apply({ ...started(2, 2), taskId: task.taskId });
    expect(task.events.slice(-2)).toEqual(["settled g1 call-1 failed", "started g2 send-2"]);
    expect(task.record()).toMatchObject({ generation: 2, startedBy: 2 });
    // Send 1 came before the send the run started, so the run already read it.
    expect(task.record().sends).toBeUndefined();
    expectLifecycle(task.events);
  });

  it("settles a send the owner cancelled as cancelled when the run starts it", () => {
    const task = driver("workflow");
    task.send(1);
    const cancelled = cancelTask(task.table(), task.taskId, NOW);
    const adopted = applyTaskMessage(
      cancelled.table,
      { ...started(2, 1), taskId: task.taskId },
      NOW,
    );
    expect(lifecycle(adopted.effects)).toEqual([
      "started g2 send-1",
      "settled g2 send-1 cancelled",
    ]);
    expect(findTask(adopted.table, task.taskId)).toMatchObject({
      cancelConfirmBy: expect.any(String),
      generation: 2,
      status: "cancelled",
    });
  });

  it("ignores stale and unrecoverable reports, and agents", () => {
    const task = driver("workflow");
    task.reply(1);
    task.send(1);
    const before = task.table();
    for (const message of [started(1, 1), started(4, 3)]) {
      expect(applyTaskMessage(before, { ...message, taskId: task.taskId }, NOW).table).toBe(before);
    }
    const agent = driver("agent");
    agent.reply(1);
    const agentTable = agent.table();
    expect(
      applyTaskMessage(agentTable, { ...started(2, 1), taskId: agent.taskId }, NOW).table,
    ).toBe(agentTable);
  });
});

describe("adoptWorkflowRun", () => {
  it("points a task at the run that reports for it", () => {
    const task = driver("workflow");
    const adopted = adoptWorkflowRun(task.table(), task.taskId, "run-2");
    expect(findTask(adopted, task.taskId)?.child).toEqual({ ...RUN, runId: "run-2" });
    expect(adoptWorkflowRun(adopted, task.taskId, "run-2")).toBe(adopted);
    const agent = driver("agent");
    expect(adoptWorkflowRun(agent.table(), agent.taskId, "run-2")).toBe(agent.table());
  });
});

describe("resumable agent tasks", () => {
  it("maps the messages an agent read onto its oldest sends", () => {
    const task = driver("agent");
    task.send(1, "turn-2");
    task.send(2, "turn-3");
    expect(task.events.slice(1)).toEqual(["input #1", "input #2"]);
    // The agent answered having read one message: the other starts its next turn.
    task.reply(1, undefined, 1);
    expect(task.events.slice(-2)).toEqual(["settled g1 call-1 completed", "started g2 send-2"]);
    // The agent answers that turn under the call it continues, and counts the message.
    expect(task.record()).toMatchObject({
      callId: "send-2",
      childCallId: "call-1",
      sends: [{ seq: 2 }],
      turnId: "turn-3",
    });
    task.reply(2, undefined, 1);
    expect(task.record()).toMatchObject({ generation: 2, status: "completed" });
    expect(task.record().sends).toBeUndefined();
    expectLifecycle(task.events);
  });

  it("never settles the next generation with a repeat of the answer that opened it", () => {
    const task = driver("agent");
    task.send(1);
    task.send(2);
    // The answer accounts for one of two messages: the call's next generation waits on the other.
    const first = {
      answer: 2,
      generation: 1,
      kind: "task.settled",
      outcome: { output: "draft", status: "completed" },
      steers: 1,
      taskId: task.taskId,
    } as const;
    task.apply(first);
    expect(task.record()).toMatchObject({ answerSeq: 2, generation: 2, status: "working" });

    // A retried callback repeats that answer. Its steering count matches what the
    // new generation waits on, but it is the same answer, so nothing settles.
    const repeated = applyTaskMessage(task.table(), { ...first, generation: 2 }, NOW);
    expect(repeated.effects).toEqual([]);
    expect(findTask(repeated.table, task.taskId)).toMatchObject({
      generation: 2,
      status: "working",
    });

    const next = applyTaskMessage(
      task.table(),
      { ...first, answer: 4, generation: 2, outcome: { output: "draft 2", status: "completed" } },
      NOW,
    );
    expect(next.effects.map(({ kind }) => kind)).toEqual(["settled"]);
    expect(findTask(next.table, task.taskId)).toMatchObject({
      answerSeq: 4,
      generation: 2,
      status: "completed",
    });
  });

  it("delivers an idle agent's send as a new call, with no command", () => {
    const task = driver("agent");
    task.reply(1);
    const sent = task.send(1, "turn-2");
    expect(sent.effects).toEqual([]);
    expect(sent.record).toMatchObject({ callId: "send-1", generation: 2, startedBy: 1 });
    expect(sent.record.childCallId).toBeUndefined();
  });

  it("settles a cancelled agent's queued sends at once: the agent dropped them", () => {
    const task = driver("agent");
    task.send(1);
    const cancelled = cancelTask(task.table(), task.taskId, NOW);
    const confirm = applyTaskMessage(
      cancelled.table,
      {
        generation: 1,
        kind: "task.settled",
        outcome: { status: "cancelled" },
        taskId: task.taskId,
      },
      NOW,
    );
    expect(lifecycle(confirm.effects)).toEqual([
      "started g2 send-1",
      "settled g2 send-1 cancelled",
    ]);
    const record = findTask(confirm.table, task.taskId)!;
    expect(record).toMatchObject({ generation: 2, status: "cancelled" });
    expect(record.cancelConfirmBy).toBeUndefined();
    expect(record.sends).toBeUndefined();
  });

  it("ends an agent whose session ended, failing the sends it never read", () => {
    const task = driver("agent");
    task.send(1);
    task.apply({
      childEnded: true,
      generation: 1,
      kind: "task.settled",
      outcome: { error: { code: "AGENT_SESSION_ENDED", message: "gone" }, status: "failed" },
      taskId: task.taskId,
    });
    expect(task.events.slice(-4)).toEqual([
      "settled g1 call-1 failed",
      "started g2 send-1",
      "settled g2 send-1 failed",
      "ended",
    ]);
    expectLifecycle(task.events);
  });
});
