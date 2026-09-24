import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { getPendingCoordinationBatch, setPendingCoordinationBatch } from "#harness/coordination.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import type { TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderTaskAlreadyWaited,
  renderTaskOtherPrincipal,
  renderUnknownTask,
  renderWaitIdle,
  TASK_WAIT_INVALID_INPUT_MESSAGE,
} from "#tasks/render.js";
import {
  encodeTaskCreator,
  holdTaskResult,
  readPendingTaskResults,
  takeTaskResults,
} from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { findTask } from "#tasks/table.js";
import { timeOutTask } from "#tasks/table-deadlines.js";
import { applyTaskWaitCall, endTaskWaits, routeDetachedResult } from "#tasks/wait.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";

const NOW = "2026-09-24T14:05:00.000Z";
const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
};
const BOB: SessionAuthContext = { ...ALICE, principalId: "U-bob" };
const LOOKUP = createTaskRecord({
  callId: "call-lookup",
  child: { commandToken: "hook", kind: "workflow", runId: "run-1" },
  creator: encodeTaskCreator({ auth: ALICE }),
  id: "lookup-q4x1ze",
  kind: "workflow",
  mode: "detached",
  name: "lookup",
  nodeId: undefined,
});
const DONE: TaskOutcome = { output: { status: "healthy" }, status: "completed" };

function waitCall(callId: string, input: JsonObject): RuntimeWorkflowTaskRequest {
  return {
    callId,
    input,
    kind: "workflow-task",
    toolName: "task_wait",
    workflowId: TASK_WAIT_WORKFLOW_ID,
  };
}

/** A session whose turn waits on these `task_wait` calls. */
function waiting(records: readonly TaskRecord[], calls: readonly RuntimeWorkflowTaskRequest[]) {
  return setPendingCoordinationBatch({
    event: { sequence: 1, stepIndex: 1, turnId: "turn-1" },
    responseMessages: [],
    session: { history: [], state: taskTableState(records) } as never,
    tasks: calls,
  });
}

function apply(
  session: ReturnType<typeof waiting>,
  call: RuntimeWorkflowTaskRequest,
  caller: SessionAuthContext | null = ALICE,
  alreadyWaited: ReadonlySet<string> = new Set(),
) {
  return applyTaskWaitCall({ alreadyWaited, caller, now: NOW, request: call, session });
}

/** Applies one step's `task_wait` calls in order, as the owner's dispatch does. */
function applyStep(
  session: ReturnType<typeof waiting>,
  calls: readonly RuntimeWorkflowTaskRequest[],
) {
  const alreadyWaited = new Set<string>();
  const results: ReturnType<typeof apply>[] = [];
  let current = session;
  for (const call of calls) {
    const applied = apply(current, call, ALICE, alreadyWaited);
    current = applied.session;
    if (applied.waitedTaskId !== undefined) alreadyWaited.add(applied.waitedTaskId);
    results.push(applied);
  }
  return { results, session: current };
}

function record(session: { readonly state?: ReturnType<typeof taskTableState> }, taskId: string) {
  return findTask(getTaskTable(session), taskId);
}

describe("applyTaskWaitCall", () => {
  it("registers a wait on a working task, and the task's result reaches it exactly once", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id });
    const applied = apply(waiting([LOOKUP], [call]), call);

    expect(applied.result).toBeUndefined();
    expect(applied.wait).toEqual({ callId: "call-w1" });
    expect(record(applied.session, LOOKUP.id)?.wait).toEqual({ callId: "call-w1", startedAt: NOW });

    const settled = { ...record(applied.session, LOOKUP.id)!, status: "completed" as const };
    const routed = routeDetachedResult(applied.session, settled, DONE);
    expect(routed.result).toEqual({
      callId: "call-w1",
      kind: "tool-result",
      output: { name: "lookup", outcome: DONE, status: "settled", taskId: LOOKUP.id },
      toolName: "task_wait",
    });
    expect(readPendingTaskResults(routed.session.state)).toEqual([]);
    expect(record(routed.session, LOOKUP.id)).toMatchObject({ delivered: true });
    expect(record(routed.session, LOOKUP.id)?.wait).toBeUndefined();
    // Nothing is left for a `task.result` message.
    expect(takeTaskResults(routed.session, ALICE).results).toEqual([]);
  });

  it("takes a result that settled before the wait began, so no task.result repeats it", () => {
    const settled = { ...LOOKUP, status: "completed" as const };
    const call = waitCall("call-w1", { taskId: LOOKUP.id, timeout: 60_000 });
    const session = holdTaskResult(waiting([settled], [call]), settled, DONE);

    const applied = apply(session, call);

    expect(applied.wait).toBeUndefined();
    expect(applied.result?.output).toEqual({
      name: "lookup",
      outcome: DONE,
      status: "settled",
      taskId: LOOKUP.id,
    });
    expect(readPendingTaskResults(applied.session.state)).toEqual([]);
    // Delivered and finished, so the owner prunes the record.
    expect(record(applied.session, LOOKUP.id)).toBeUndefined();
  });

  it("fails TASK_ALREADY_WAITED for a second wait on one task in the same step", () => {
    const first = waitCall("call-w1", { taskId: LOOKUP.id });
    const second = waitCall("call-w2", { taskId: LOOKUP.id });
    const {
      results: [one, two],
    } = applyStep(waiting([LOOKUP], [first, second]), [first, second]);
    if (one === undefined || two === undefined) throw new Error("Expected two waits.");

    expect(one.wait?.callId).toBe("call-w1");
    expect(two.wait).toBeUndefined();
    expect(two.result).toEqual({
      callId: "call-w2",
      isError: true,
      kind: "tool-result",
      output: { code: "TASK_ALREADY_WAITED", message: renderTaskAlreadyWaited(LOOKUP.id) },
      toolName: "task_wait",
    });
    expect(record(two.session, LOOKUP.id)?.wait?.callId).toBe("call-w1");
  });

  it("fails TASK_ALREADY_WAITED when the first wait took a held result and the record is gone", () => {
    // Alice's lookup finished before her turn waited twice on it in one step.
    const settled = { ...LOOKUP, status: "completed" as const };
    const first = waitCall("call-w1", { taskId: LOOKUP.id });
    const second = waitCall("call-w2", { taskId: LOOKUP.id });
    const session = holdTaskResult(waiting([settled], [first, second]), settled, DONE);

    const { results, session: after } = applyStep(session, [first, second]);

    expect(results[0]?.result?.output).toMatchObject({ status: "settled", taskId: LOOKUP.id });
    // Delivered and finished, so the record was pruned before the second wait.
    expect(record(after, LOOKUP.id)).toBeUndefined();
    expect(results[1]?.result?.output).toEqual({
      code: "TASK_ALREADY_WAITED",
      message: renderTaskAlreadyWaited(LOOKUP.id),
    });
  });

  it("fails TASK_ALREADY_WAITED rather than idle for an agent the first wait already read", () => {
    const agent = createTaskRecord({
      child: { continuationToken: "token", kind: "local", sessionId: "child" },
      creator: encodeTaskCreator({ auth: ALICE }),
      id: "research-7k2m9q",
      mode: "detached",
      status: "completed",
    });
    const first = waitCall("call-w1", { taskId: agent.id });
    const second = waitCall("call-w2", { taskId: agent.id });
    const session = holdTaskResult(waiting([agent], [first, second]), agent, DONE);

    const { results } = applyStep(session, [first, second]);

    expect(results[0]?.result?.output).toMatchObject({ status: "settled" });
    expect(results[1]?.result?.output).toMatchObject({ code: "TASK_ALREADY_WAITED" });
  });

  it("takes an earlier generation's held result while the agent works on the next one", () => {
    // Bob's message reached the researcher after it answered, so it runs the message as generation 2.
    const agent = createTaskRecord({
      child: { continuationToken: "token", kind: "local", sessionId: "child" },
      creator: encodeTaskCreator({ auth: ALICE }),
      generation: 2,
      id: "research-7k2m9q",
      mode: "detached",
    });
    const first: TaskOutcome = { output: "First answer.", status: "completed" };
    const call = waitCall("call-w1", { taskId: agent.id });
    const session = holdTaskResult(waiting([agent], [call]), { ...agent, generation: 1 }, first);

    const applied = apply(session, call);

    expect(applied.wait).toBeUndefined();
    expect(applied.result?.output).toMatchObject({ outcome: first, status: "settled" });
    expect(readPendingTaskResults(applied.session.state)).toEqual([]);
    // The working generation's own result is still to come.
    expect(record(applied.session, agent.id)).toMatchObject({ delivered: false, generation: 2 });
  });

  it("reads a finished agent a workflow body started as idle, as the [Tasks] note lists it", () => {
    const agent = createTaskRecord({
      child: { continuationToken: "token", kind: "local", sessionId: "child" },
      creator: encodeTaskCreator({ auth: ALICE }),
      delivered: true,
      id: "research-b81d0c",
      status: "completed",
      workflowCaller: { replyTo: "reply-hook", runId: "run-9" },
    });
    const call = waitCall("call-w1", { taskId: agent.id });

    expect(apply(waiting([agent], [call]), call).result?.output).toEqual({
      status: "idle",
      taskId: agent.id,
    });
  });

  it("fails TASK_OTHER_PRINCIPAL for a task another caller started", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id });
    const session = waiting([LOOKUP], [call]);

    for (const caller of [BOB, null]) {
      const applied = apply(session, call, caller);
      expect(applied.result?.output).toEqual({
        code: "TASK_OTHER_PRINCIPAL",
        message: renderTaskOtherPrincipal(LOOKUP.id),
      });
      expect(applied.session).toBe(session);
    }
  });

  it.each([
    ["an ID the session never had", "lookup-zzzzzz"],
    ["a call its turn still waits on", "deploy-a1b2c3"],
    ["a call a workflow body awaits", "research-b81d0c"],
    ["a workflow task whose result was delivered", "remind-3fq8wd"],
  ])("fails UNKNOWN_TASK for %s", (_label, taskId) => {
    const records = [
      createTaskRecord({ callId: "call-deploy", id: "deploy-a1b2c3", kind: "workflow" }),
      createTaskRecord({
        callId: "call-nested",
        creator: encodeTaskCreator({ auth: ALICE }),
        id: "research-b81d0c",
        mode: "detached",
        workflowCaller: { replyTo: "reply-hook", runId: "run-9" },
      }),
      {
        ...LOOKUP,
        callId: "call-remind",
        cancelConfirmBy: NOW,
        delivered: true,
        id: "remind-3fq8wd",
        status: "cancelled" as const,
      },
    ];
    const call = waitCall("call-w1", { taskId });

    expect(apply(waiting(records, [call]), call).result?.output).toEqual({
      code: "UNKNOWN_TASK",
      message: renderUnknownTask(taskId),
    });
  });

  it("returns at once for timeout 0 without registering a wait", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id, timeout: 0 });
    const session = waiting([LOOKUP], [call]);

    const applied = apply(session, call);

    expect(applied.wait).toBeUndefined();
    expect(applied.session).toBe(session);
    expect(applied.result).toMatchObject({
      modelOutput: expect.stringContaining(`${LOOKUP.id} is still working`),
      output: { status: "timed_out", taskId: LOOKUP.id },
    });
  });

  it("reports a task that waits on a person for timeout 0", () => {
    const asking = { ...LOOKUP, clockStoppedAt: NOW, status: "input_required" as const };
    const call = waitCall("call-w1", { taskId: LOOKUP.id, timeout: 0 });

    const applied = apply(waiting([asking], [call]), call);

    expect(applied.result?.modelOutput).toBe(
      "Stopped waiting after 0 ms; lookup-q4x1ze is waiting on a person. Its result arrives in a later message; wait again only if you need it now.",
    );
  });

  it("returns idle for an idle agent with nothing new", () => {
    const idle = createTaskRecord({
      child: { continuationToken: "token", kind: "local", sessionId: "child" },
      creator: encodeTaskCreator({ auth: ALICE }),
      delivered: true,
      id: "research-7k2m9q",
      status: "completed",
    });
    const call = waitCall("call-w1", { taskId: idle.id });

    expect(apply(waiting([idle], [call]), call).result).toEqual({
      callId: "call-w1",
      kind: "tool-result",
      modelOutput: renderWaitIdle(idle),
      output: { status: "idle", taskId: idle.id },
      toolName: "task_wait",
    });
  });

  it.each([
    [{}],
    [{ taskId: "" }],
    [{ taskId: LOOKUP.id, timeout: -1 }],
    [{ taskId: LOOKUP.id, timeout: "5m" }],
  ])("rejects the input %o", (input) => {
    const call = waitCall("call-w1", input as JsonObject);
    expect(apply(waiting([LOOKUP], [call]), call).result?.output).toEqual({
      code: "INVALID_INPUT",
      message: TASK_WAIT_INVALID_INPUT_MESSAGE,
    });
  });
});

describe("routeDetachedResult", () => {
  it("holds a result for task.result when no wait covers the task", () => {
    const settled = { ...LOOKUP, status: "completed" as const };
    const routed = routeDetachedResult(waiting([settled], []), settled, DONE);

    expect(routed.result).toBeUndefined();
    expect(readPendingTaskResults(routed.session.state)).toHaveLength(1);
  });

  it("never gives a result to a wait whose turn moved on", () => {
    const stale = {
      ...LOOKUP,
      status: "completed" as const,
      wait: { callId: "gone", startedAt: NOW },
    };
    const routed = routeDetachedResult(waiting([stale], []), stale, DONE);

    expect(routed.result).toBeUndefined();
    expect(readPendingTaskResults(routed.session.state)).toHaveLength(1);
    expect(record(routed.session, LOOKUP.id)?.wait).toBeUndefined();
  });

  it("gives a wait the TIMED_OUT failure of a task that ran out of time", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id });
    const applied = apply(waiting([{ ...LOOKUP, timeoutMs: 60_000 }], [call]), call);
    const timedOut = timeOutTask(getTaskTable(applied.session), LOOKUP.id, NOW);
    const effect = timedOut.effects.find((candidate) => candidate.kind === "settled")!;

    const routed = routeDetachedResult(applied.session, effect.record, effect.outcome);

    expect(routed.result?.output).toMatchObject({
      outcome: { error: { code: "TIMED_OUT" }, status: "failed" },
      status: "settled",
    });
  });
});

describe("endTaskWaits", () => {
  it("ends a timed-out wait, and the task's later result is held for task.result", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id, timeout: 5_000 });
    const applied = apply(waiting([LOOKUP], [call]), call);

    const ended = endTaskWaits(applied.session, {
      callIds: ["call-w1"],
      now: "2026-09-24T14:05:05.000Z",
      reason: "timed_out",
    });

    expect(ended.results).toEqual([
      {
        callId: "call-w1",
        kind: "tool-result",
        modelOutput: expect.stringContaining(
          "Stopped waiting after 5 s; lookup-q4x1ze is still working.",
        ),
        output: { status: "timed_out", taskId: LOOKUP.id },
        toolName: "task_wait",
      },
    ]);
    const settled = { ...record(ended.session, LOOKUP.id)!, status: "completed" as const };
    const routed = routeDetachedResult(ended.session, settled, DONE);
    expect(routed.result).toBeUndefined();
    expect(readPendingTaskResults(routed.session.state)).toHaveLength(1);
  });

  it("interrupts every wait, telling the model how to correct an agent", () => {
    const agent = createTaskRecord({
      callId: "call-research",
      creator: encodeTaskCreator({ auth: ALICE }),
      id: "research-7k2m9q",
      mode: "detached",
    });
    const w1 = waitCall("call-w1", { taskId: LOOKUP.id });
    const w2 = waitCall("call-w2", { taskId: agent.id });
    let session = waiting([LOOKUP, agent], [w1, w2]);
    session = apply(session, w1).session;
    session = apply(session, w2).session;

    const ended = endTaskWaits(session, {
      callIds: ["call-w1", "call-w2"],
      now: "2026-09-24T14:05:40.000Z",
      reason: "interrupted",
    });

    expect(ended.results.map((result) => result.output)).toEqual([
      { status: "interrupted", taskId: LOOKUP.id },
      { status: "interrupted", taskId: agent.id },
    ]);
    expect(ended.results[0]?.modelOutput).toBe(
      "A new message arrived, so the wait ended after 40 s; lookup-q4x1ze is still working. Read the message and decide whether it changes this work: keep the task or stop it with task_cancel.",
    );
    expect(ended.results[1]?.modelOutput).toContain("pass its id as agentId to research");
    expect(getTaskTable(ended.session).records.every((entry) => entry.wait === undefined)).toBe(
      true,
    );
  });

  it("clears a cancelled turn's waits without results, leaving other state alone", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id });
    const applied = apply(waiting([LOOKUP], [call]), call);

    const ended = endTaskWaits(applied.session, { now: NOW, reason: "turn-cancelled" });

    expect(ended.results).toEqual([]);
    expect(record(ended.session, LOOKUP.id)).toMatchObject({ status: "working" });
    expect(record(ended.session, LOOKUP.id)?.wait).toBeUndefined();
    expect(getPendingCoordinationBatch(ended.session.state)).toBeDefined();
  });

  it("leaves a session with no waits unchanged", () => {
    const session = waiting([LOOKUP], []);
    expect(endTaskWaits(session, { now: NOW, reason: "interrupted" }).session).toBe(session);
  });

  it.each([
    ["timed_out", { status: "timed_out", taskId: LOOKUP.id }],
    ["interrupted", { status: "interrupted", taskId: LOOKUP.id }],
  ] as const)(
    "still ends a %s wait that no record points at, naming the task from the call",
    (reason, output) => {
      // The wait's pointer is gone, so no result could ever reach it.
      const call = waitCall("call-w1", { taskId: LOOKUP.id, timeout: 5_000 });
      const session = waiting([LOOKUP], [call]);

      const ended = endTaskWaits(session, { callIds: ["call-w1"], now: NOW, reason });

      expect(ended.results).toEqual([
        expect.objectContaining({ callId: "call-w1", output, toolName: "task_wait" }),
      ]);
      expect(ended.results[0]?.modelOutput).toContain(`${LOOKUP.id} is still working`);
    },
  );

  it("leaves a wait an unreadable record names for the loss report", () => {
    const call = waitCall("call-w1", { taskId: LOOKUP.id });
    const session = waiting([], [call]);
    const lost = {
      ...session,
      state: {
        ...session.state,
        ...taskTableState([
          { ...LOOKUP, v: 99, wait: { callId: "call-w1", startedAt: NOW } } as never,
        ]),
      },
    };

    expect(
      endTaskWaits(lost, { callIds: ["call-w1"], now: NOW, reason: "interrupted" }).results,
    ).toEqual([]);
  });
});
