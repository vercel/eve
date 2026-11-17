import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { backgroundTaskOf, startProgramOnSleeper } from "./background-program";

/** The id the scripted parent gives its `eve__execute` call; its agent call takes `<id>/1`. */
const PROGRAM_CALL = "cancel-sleeper";
const AGENT_CALL = `${PROGRAM_CALL}/1`;
const TASK_CANCEL_TOOL = "eve__task_cancel";

export default defineEval({
  description:
    "eve__task_cancel on a program that a new message moved to the background stops the program and cancels the agent session it waits on.",
  timeoutMs: 240_000,

  async test(t) {
    const { child, parent } = await startProgramOnSleeper(t, {
      prompt:
        "Alice wants the sleeper to hold its turn while she checks that stopping works. Please ask the sleeper agent from one program to wait for cancellation, and return what it replies.",
      tool: "wait-for-cancellation",
    });

    const stop = await parent.session.start(
      "Alice has seen enough and no longer needs the sleeper's reply. Please stop the program that is asking the sleeper with eve__task_cancel, and confirm once it has stopped.",
      { turnPolicy: "steer" },
    );
    const turn = await parent.result();
    await stop.result();
    const sleeperTurn = await child.result();
    turn.expectOk();

    const taskId = backgroundTaskOf(turn.events, PROGRAM_CALL);
    turn.eventOrder([
      {
        count: 1,
        data: { kind: "tool", name: EXECUTE_TOOL, startedBy: { callId: PROGRAM_CALL } },
        type: "task.started",
      },
      // The scripted model copies the task id from the receipt that answered its program's call.
      {
        count: 1,
        data: { capability: { name: TASK_CANCEL_TOOL }, input: { taskId } },
        type: "call.requested",
      },
      {
        count: 1,
        data: { outcome: "cancelled", reason: "task-cancel", taskId },
        type: "task.ended",
      },
      {
        count: 1,
        data: {
          kind: "text",
          value: new RegExp(`^The sleeper's program is stopped: Stopped ${taskId}`, "u"),
        },
        type: "content.completed",
      },
      { count: 1, data: { outcome: "completed" }, type: "turn.settled" },
    ]);
    // The cancel stops both calls before either returns a value.
    turn.event("call.settled", {
      count: 1,
      data: { callId: PROGRAM_CALL, outcome: "interrupted" },
    });
    turn.event("call.settled", { count: 1, data: { callId: AGENT_CALL, outcome: "interrupted" } });
    turn.event("turn.started", { count: 1 });
    // The program's agent call opened one session, and the cancel reached it.
    turn.event("child.opened", {
      count: 1,
      data: { name: "sleeper", owner: { callId: AGENT_CALL } },
    });
    sleeperTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
  },
});
