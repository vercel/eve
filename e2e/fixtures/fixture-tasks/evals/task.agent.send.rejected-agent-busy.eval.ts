import { type EveEvalToolCall } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
} from "./shared.js";

/** A persistent child with a nonterminal task rejects every competing send. */
export default defineTaskEval({
  description:
    "One competing task_send is admitted; same-batch and later sends are rejected as AGENT_BUSY without task receipts.",
  transition: {
    primary: "task.agent.send.rejected-agent-busy",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.lifecycle.complete.accepted-nonterminal",
      "task.agent.send.accepted-terminal-available",
    ],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const setup = await t.send("CHILD-TASK-EXCLUSIVITY-SETUP");
    setup.expectOk();
    setup.messageIncludes("CHILD-TASK-EXCLUSIVITY-READY");
    const initialTaskId = requireBackgroundTaskId(setup);
    await waitForCompletedTask(t, t, "CHILD-TASK-EXCLUSIVITY-VERIFY", initialTaskId);

    const race = await sendAndFollowQueuedTurn(t, "CHILD-TASK-EXCLUSIVITY-RACE", t, {
      allowFailedActions: true,
    });
    const raced = race.turn;
    raced.expectOk();
    raced.messageIncludes("CHILD-TASK-EXCLUSIVITY-RACE-DONE");

    const sends = raced.toolCalls.filter((call) => call.name === "task_send");
    const admitted = sends.filter(hasTaskReceipt);
    await t.require(
      sends,
      satisfies(
        (calls: readonly EveEvalToolCall[]) =>
          calls.length === 2 &&
          calls.filter(hasTaskReceipt).length === 1 &&
          calls.filter((call) => isBusyRejection(call.output)).length === 1,
        "one competing send is admitted and one is rejected without a task receipt",
      ),
    );

    const admittedTaskId = taskIdFromReceipt(admitted[0]);
    const rejected = sends.find((call) => isBusyRejection(call.output));
    await t.require(
      rejected?.output,
      satisfies(
        (output) => isBusyRejection(output, admittedTaskId),
        "the same-batch rejection identifies the admitted task and creates no task receipt",
      ),
    );

    const later = await sendAndFollowQueuedTurn(
      t,
      `CHILD-TASK-EXCLUSIVITY-LATER ${initialTaskId}`,
      race.session,
      { allowFailedActions: true },
    );
    const laterSends = later.turn.toolCalls.filter((call) => call.name === "task_send");
    await t.require(
      laterSends,
      satisfies(
        (calls: readonly EveEvalToolCall[]) =>
          calls.length === 1 && isBusyRejection(calls[0]?.output, admittedTaskId),
        "the later rejection creates no task receipt while the admitted task is nonterminal",
      ),
    );

    await waitForCompletedTask(t, later.session, "CHILD-TASK-EXCLUSIVITY-VERIFY", admittedTaskId);
  },
});

function hasTaskReceipt(call: EveEvalToolCall): boolean {
  return (
    call.output !== null &&
    typeof call.output === "object" &&
    typeof Reflect.get(call.output, "agentId") === "string" &&
    typeof Reflect.get(call.output, "taskId") === "string" &&
    Reflect.get(call.output, "status") === "working"
  );
}

function taskIdFromReceipt(call: EveEvalToolCall | undefined): string {
  const output = call?.output;
  const taskId =
    output !== null && typeof output === "object" ? Reflect.get(output, "taskId") : null;
  if (typeof taskId !== "string") throw new Error("No admitted continuation task id.");
  return taskId;
}

function isBusyRejection(output: unknown, activeTaskId?: string): boolean {
  if (output === null || typeof output !== "object") return false;
  const keys = Object.keys(output);
  const message = Reflect.get(output, "message");
  return (
    keys.length === 1 &&
    keys[0] === "message" &&
    typeof message === "string" &&
    message.startsWith("AGENT_BUSY") &&
    (activeTaskId === undefined || message.includes(activeTaskId))
  );
}
