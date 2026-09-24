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
  mode: "background",
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
) {
  return applyTaskWaitCall({ caller, now: NOW, request: call, session });
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
    const one = apply(waiting([LOOKUP], [first, second]), first);
    const two = apply(one.session, second);

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
        mode: "background",
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
      mode: "background",
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
});
