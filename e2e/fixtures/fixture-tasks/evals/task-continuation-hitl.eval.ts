import { defineEval } from "eve/evals";

import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";

/** A reused child must route every new-turn event through the new owning task. */
export default defineEval({
  description: "task_send rebinds a reused child's HITL events to the new task lifecycle.",
  async test(t) {
    t.log("starting first task");
    const setup = await t.send("TASK-CONTINUATION-HITL-SETUP");
    setup.expectOk();
    const firstTaskId = requireBackgroundTaskId(setup);

    const first = await waitForTaskInput(t, t, "first_gate");
    t.log("answering first task gate one");
    const firstAnswered = await first.session.respond({
      optionId: "approve",
      requestId: first.request.requestId,
    });
    firstAnswered.notEvent("step.started");
    const second = await waitForTaskInput(t, first.session, "second_gate");
    t.log("answering first task gate two");
    await second.session.respond({ optionId: "approve", requestId: second.request.requestId });
    await waitForCompletedTask(t, second.session, "TASK-HITL-VERIFY", firstTaskId);
    t.log("first task completed; sending continuation");

    const continued = await sendAndFollowQueuedTurn(
      t,
      `TASK-CONTINUATION-HITL-SEND ${firstTaskId}`,
      second.session,
    );
    continued.turn.expectOk();
    const send = continued.turn.toolCalls.find((call) => call.name === "task_send");
    const secondTaskId =
      send?.output !== null && typeof send?.output === "object"
        ? Reflect.get(send.output, "taskId")
        : undefined;
    if (typeof secondTaskId !== "string") throw new Error("task_send returned no new task id.");
    t.log("continuation admitted; waiting for rebound HITL");
    const continuedThird = await waitForTaskInput(t, continued.session, "third_gate");
    const continuedThirdAnswer = await continuedThird.session.respond({
      optionId: "approve",
      requestId: continuedThird.request.requestId,
    });
    continuedThirdAnswer.notEvent("step.started");
    const continuedFourth = await waitForTaskInput(t, continuedThird.session, "fourth_gate");
    await continuedFourth.session.respond({
      optionId: "approve",
      requestId: continuedFourth.request.requestId,
    });
    await waitForCompletedTask(
      t,
      continuedFourth.session,
      "TASK-HITL-VERIFY",
      secondTaskId,
    );
    t.noFailedActions();
  },
});
