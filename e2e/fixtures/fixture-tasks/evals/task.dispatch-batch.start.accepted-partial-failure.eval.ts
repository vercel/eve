import { type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireTaskView, waitForCompletedTask, waitForTaskStatus } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const FIRST_CALL_ID = "task-d6-success-first";
const FAILED_CALL_ID = "task-d6-failure-middle";
const THIRD_CALL_ID = "task-d6-success-third";

/** A failed middle dispatch does not stop later siblings from completing. */
export default defineTaskEval({
  description:
    "An ordered success/failure/success fanout admits every sibling and records the unreachable child as failed.",
  transition: {
    primary: "task.dispatch-batch.start.accepted-partial-failure",
    dimensions: { transport: "mixed", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-D6-PARTIAL-FANOUT-FAILURE");
    started.expectOk();
    started.messageIncludes("TASK-D6-PARTIAL-FANOUT-STARTED");
    started.eventsSatisfy("dispatch results cover every sibling", (events) => {
      const callIds = events.flatMap((event) =>
        event.type === "action.result" &&
        event.data.result.kind === "tool-result" &&
        (event.data.result.toolName === "busy-worker" ||
          event.data.result.toolName === "unstartable-worker")
          ? [event.data.result.callId]
          : [],
      );
      return (
        callIds.length === 3 &&
        new Set(callIds).size === 3 &&
        [FIRST_CALL_ID, FAILED_CALL_ID, THIRD_CALL_ID].every((callId) => callIds.includes(callId))
      );
    });

    const receipts = backgroundReceipts(started);
    await t.require(
      receipts,
      satisfies(
        (values: readonly BackgroundReceipt[]) =>
          values.length === 3 &&
          values.some(({ callId }) => callId === FIRST_CALL_ID) &&
          values.some(({ callId }) => callId === FAILED_CALL_ID) &&
          values.some(({ callId }) => callId === THIRD_CALL_ID) &&
          new Set(values.map(({ taskId }) => taskId)).size === 3,
        "every fanout entry returns a distinct working task receipt",
      ),
    );
    const firstTaskId = requireReceiptTaskId(receipts, FIRST_CALL_ID);
    const failedTaskId = requireReceiptTaskId(receipts, FAILED_CALL_ID);
    const thirdTaskId = requireReceiptTaskId(receipts, THIRD_CALL_ID);
    started.event("subagent.completed", {
      count: 2,
      data: {
        backgroundTask: { status: "working" },
        subagentName: "busy-worker",
      },
    });

    const firstCompleted = await waitForCompletedTask(
      t,
      t,
      "TASK-D6-PARTIAL-FANOUT-VERIFY",
      firstTaskId,
    );
    assertCompletedBusyWorker(firstCompleted, firstTaskId, "TASK-D6-FIRST-SUCCESS");
    const thirdCompleted = await waitForCompletedTask(
      t,
      t,
      "TASK-D6-PARTIAL-FANOUT-VERIFY",
      thirdTaskId,
    );
    assertCompletedBusyWorker(thirdCompleted, thirdTaskId, "TASK-D6-THIRD-SUCCESS");
    const failed = await waitForTaskStatus(
      t,
      t,
      "TASK-D6-PARTIAL-FANOUT-UNKNOWN",
      failedTaskId,
      "failed",
    );
    assertFailedUnstartableWorker(failed, failedTaskId);
  },
});

interface BackgroundReceipt {
  readonly callId: string;
  readonly taskId: string;
}

function backgroundReceipts(turn: EveEvalTurn): readonly BackgroundReceipt[] {
  return turn.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [{ callId: event.data.callId, taskId: event.data.backgroundTask.taskId }]
      : [],
  );
}

function requireReceiptTaskId(receipts: readonly BackgroundReceipt[], callId: string): string {
  const matching = receipts.filter((receipt) => receipt.callId === callId);
  if (matching.length !== 1) throw new Error(`Expected one background receipt for ${callId}.`);
  return matching[0]!.taskId;
}

function assertCompletedBusyWorker(turn: EveEvalTurn, taskId: string, marker: string): void {
  turn.expectOk();
  turn.messageIncludes("TASK-D6-STATUS");
  const view = requireTaskView(turn.requireToolCall("task_cancel").output, taskId);
  const metadata = Reflect.get(view, "metadata");
  const lastOutput = Reflect.get(view, "lastOutput");
  if (
    Reflect.get(view, "status") !== "completed" ||
    metadata === null ||
    typeof metadata !== "object" ||
    Reflect.get(metadata, "name") !== "busy-worker" ||
    lastOutput === null ||
    typeof lastOutput !== "object" ||
    Reflect.get(lastOutput, "type") !== "result" ||
    !String(Reflect.get(lastOutput, "data")).includes(marker)
  ) {
    throw new Error(`Task ${taskId} did not complete with marker ${marker}.`);
  }
}

function assertFailedUnstartableWorker(turn: EveEvalTurn, taskId: string): void {
  turn.expectOk();
  turn.messageIncludes("TASK-D6-UNKNOWN");
  const view = requireTaskView(turn.requireToolCall("task_cancel").output, taskId);
  const metadata = Reflect.get(view, "metadata");
  const lastOutput = Reflect.get(view, "lastOutput");
  if (
    Reflect.get(view, "status") !== "failed" ||
    metadata === null ||
    typeof metadata !== "object" ||
    Reflect.get(metadata, "kind") !== "subagent" ||
    Reflect.get(metadata, "mode") !== "remote" ||
    Reflect.get(metadata, "name") !== "unstartable-worker" ||
    lastOutput === null ||
    typeof lastOutput !== "object" ||
    Reflect.get(lastOutput, "type") !== "error"
  ) {
    throw new Error(`Task ${taskId} did not fail with unstartable-worker metadata.`);
  }
}
