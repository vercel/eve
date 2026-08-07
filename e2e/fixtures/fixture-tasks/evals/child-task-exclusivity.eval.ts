import { defineEval, type EveEvalToolCall } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
} from "./shared.js";

/** One persistent child session admits at most one nonterminal task. */
export default defineEval({
  description:
    "Two same-batch task_send calls to one child admit one task and reject the other as AGENT_BUSY.",
  async test(t) {
    t.log("starting initial busy-worker task");
    const setup = await t.send("CHILD-TASK-EXCLUSIVITY-SETUP");
    t.log("initial busy-worker task settled");
    setup.expectOk();
    setup.messageIncludes("CHILD-TASK-EXCLUSIVITY-READY");
    const initialTaskId = requireBackgroundTaskId(setup);
    await waitForCompletedTask(t, t, "CHILD-TASK-EXCLUSIVITY-VERIFY", initialTaskId);

    t.log("sending two same-batch continuations");
    const race = await sendAndFollowQueuedTurn(t, "CHILD-TASK-EXCLUSIVITY-RACE");
    const raced = race.turn;
    t.log("same-batch continuation turn settled");
    raced.expectOk();
    raced.messageIncludes("CHILD-TASK-EXCLUSIVITY-RACE-DONE");

    const sends = raced.toolCalls.filter((call) => call.name === "task_send");
    await t.require(
      sends,
      satisfies((calls: readonly EveEvalToolCall[]) => {
        const admitted = calls.find(
          (call) =>
            call.output !== null &&
            typeof call.output === "object" &&
            typeof Reflect.get(call.output, "agentId") === "string" &&
            typeof Reflect.get(call.output, "taskId") === "string" &&
            Reflect.get(call.output, "status") === "working",
        );
        const admittedTaskId =
          admitted?.output !== null && typeof admitted?.output === "object"
            ? Reflect.get(admitted.output, "taskId")
            : undefined;
        const rejected = calls.find((call) => {
          if (call.output === null || typeof call.output !== "object") return false;
          const keys = Object.keys(call.output);
          const message = Reflect.get(call.output, "message");
          return (
            keys.length === 1 &&
            keys[0] === "message" &&
            typeof message === "string" &&
            message.startsWith("AGENT_BUSY") &&
            (typeof admittedTaskId !== "string" || message.includes(admittedTaskId))
          );
        });
        return calls.length === 2 && admitted !== undefined && rejected !== undefined;
      }, "exactly one same-batch task_send is admitted"),
    );

    const admitted = sends.find(
      (call) =>
        call.output !== null &&
        typeof call.output === "object" &&
        Reflect.get(call.output, "status") === "working",
    );
    const admittedTaskId =
      admitted?.output !== null && typeof admitted?.output === "object"
        ? Reflect.get(admitted.output, "taskId")
        : undefined;
    if (typeof admittedTaskId !== "string") throw new Error("No admitted continuation task id.");

    const later = await sendAndFollowQueuedTurn(
      t,
      `CHILD-TASK-EXCLUSIVITY-LATER ${initialTaskId}`,
      race.session,
    );
    const laterSend = later.turn.toolCalls.find((call) => call.name === "task_send");
    await t.require(
      laterSend?.output,
      satisfies(
        (output) => JSON.stringify(output).includes("AGENT_BUSY"),
        "a later parent turn remains excluded while the admitted task is nonterminal",
      ),
    );

    await t.sleep(5_000);
    await waitForCompletedTask(t, later.session, "CHILD-TASK-EXCLUSIVITY-VERIFY", admittedTaskId);
  },
});
