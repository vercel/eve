import { type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireTaskView, waitForCompletedTask } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const FIRST_CALL_ID = "task-d6-success-first";
const FAILED_CALL_ID = "task-d6-failure-middle";
const THIRD_CALL_ID = "task-d6-success-third";

/** A failed middle dispatch does not stop later siblings or enter the task index. */
export default defineTaskEval({
  description:
    "An ordered success/failure/success fanout admits both siblings and excludes the failed start.",
  transition: {
    primary: "task.dispatch-batch.start.accepted-partial-failure",
    dimensions: { transport: "mixed", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-D6-PARTIAL-FANOUT-FAILURE");
    started.expectOk();
    started.messageIncludes("TASK-D6-PARTIAL-FANOUT-STARTED");
    started.eventsSatisfy("dispatch results preserve success/failure/success order", (events) => {
      const callIds = events.flatMap((event) =>
        event.type === "action.result" && event.data.result.kind === "subagent-result"
          ? [event.data.result.callId]
          : [],
      );
      return callIds.join(",") === [FIRST_CALL_ID, FAILED_CALL_ID, THIRD_CALL_ID].join(",");
    });

    const receipts = backgroundReceipts(started);
    await t.require(
      receipts,
      satisfies(
        (values: readonly BackgroundReceipt[]) =>
          values.length === 2 &&
          values[0]?.callId === FIRST_CALL_ID &&
          values[1]?.callId === THIRD_CALL_ID &&
          values[0].taskId !== values[1].taskId,
        "first and third entries return distinct working task receipts",
      ),
    );
    const firstTaskId = requireReceiptTaskId(receipts, FIRST_CALL_ID);
    const thirdTaskId = requireReceiptTaskId(receipts, THIRD_CALL_ID);
    started.eventsSatisfy(
      "failed middle start has no task id, receipt, or index admission",
      (events) => {
        const failed = events.filter(
          (event) =>
            event.type === "action.result" &&
            event.data.result.kind === "subagent-result" &&
            event.data.result.callId === FAILED_CALL_ID,
        );
        const event = failed[0];
        if (event?.type !== "action.result") return false;
        const result = event.data.result;
        if (result.kind !== "subagent-result") return false;
        const output = result.output;
        return (
          failed.length === 1 &&
          event.data.status === "failed" &&
          result.origin === "dispatch" &&
          output !== null &&
          typeof output === "object" &&
          Reflect.get(output, "code") === "REMOTE_AGENT_START_FAILED" &&
          !Object.hasOwn(output, "taskId") &&
          !events.some(
            (event) => event.type === "subagent.called" && event.data.callId === FAILED_CALL_ID,
          ) &&
          !events.some(
            (event) =>
              event.type === "subagent.completed" &&
              event.data.callId === FAILED_CALL_ID &&
              event.data.backgroundTask !== undefined,
          )
        );
      },
    );
    started.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working", taskId: thirdTaskId },
        callId: THIRD_CALL_ID,
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
  const view = requireTaskView(turn.requireToolCall("task_peek").output, taskId);
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
