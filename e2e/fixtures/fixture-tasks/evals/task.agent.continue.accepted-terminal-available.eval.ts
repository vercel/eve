import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

/** A reused child must route every new-turn event through the new owning task. */
export default defineTaskEval({
  description: "An agentId continuation rebinds a reused child's HITL events to a new task.",
  transition: {
    primary: "task.agent.continue.accepted-terminal-available",
    setup: ["task.input.answer.accepted-complete"],
    dimensions: { transport: "local" },
  },
  async test(t) {
    t.log("starting first task");
    const setup = await t.send("TASK-CONTINUATION-HITL-SETUP");
    setup.expectOk();
    const firstTaskId = requireBackgroundTaskId(setup);

    const first = await waitForTaskInput(t, t, "first_gate");
    t.log("answering first task gate one");
    const firstAnswered = await first.session.respond([
      {
        optionId: "approve",
        requestId: first.request.requestId,
      },
    ]);
    firstAnswered.notEvent("step.started");
    const second = await waitForTaskInput(t, first.session, "second_gate");
    t.log("answering first task gate two");
    await second.session.respond([{ optionId: "approve", requestId: second.request.requestId }]);
    const firstTerminal = await waitForCompletedTask(
      t,
      second.session,
      "TASK-HITL-VERIFY",
      firstTaskId,
    );
    const firstView = requireTaskView(
      firstTerminal.requireToolCall("task_peek").output,
      firstTaskId,
    );
    const firstAgentId = requireAgentId(firstView);
    t.log("first task completed; sending continuation");

    const continued = await sendAndFollowQueuedTurn(
      t,
      `TASK-CONTINUATION-HITL-SEND ${firstAgentId}`,
      second.session,
    );
    continued.turn.expectOk();
    const secondTaskId = requireBackgroundTaskId(continued.turn);
    await t.require(
      secondTaskId,
      satisfies((taskId) => taskId !== firstTaskId, "continuation creates a new task identity"),
    );
    t.log("continuation admitted; waiting for rebound HITL");
    const continuedThird = await waitForTaskInput(t, continued.session, "third_gate");
    const continuedThirdAnswer = await continuedThird.session.respond([
      {
        optionId: "approve",
        requestId: continuedThird.request.requestId,
      },
    ]);
    continuedThirdAnswer.notEvent("step.started");
    const continuedFourth = await waitForTaskInput(t, continuedThird.session, "fourth_gate");
    await continuedFourth.session.respond([
      {
        optionId: "approve",
        requestId: continuedFourth.request.requestId,
      },
    ]);
    const secondTerminal = await waitForCompletedTask(
      t,
      continuedFourth.session,
      "TASK-HITL-VERIFY",
      secondTaskId,
    );
    const secondView = requireTaskView(
      secondTerminal.requireToolCall("task_peek").output,
      secondTaskId,
    );
    await t.require(
      secondView,
      satisfies(
        (view: Record<string, unknown>) => requireAgentId(view) === firstAgentId,
        "the new task retains the reused child's agent identity",
      ),
    );
    t.noFailedActions();
  },
});

function requireAgentId(view: Record<string, unknown>): string {
  const metadata = Reflect.get(view, "metadata");
  const agentId =
    metadata !== null && typeof metadata === "object"
      ? Reflect.get(metadata, "agentId")
      : undefined;
  if (typeof agentId !== "string") throw new Error("Task view has no agent id.");
  return agentId;
}
