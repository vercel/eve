import { defineEval } from "eve/evals";

import { STAGE_INTERIM_MESSAGE } from "../task-scenario-text";
import { HELD_TURN, staysInOneTurn } from "./held-turn.shared";

/**
 * The model starts `stage_deploy`, then ends its step with text instead of
 * waiting. The turn rule holds the turn: the text completes as an ordinary
 * message, the stream shows a waiting boundary that names the held turn, and
 * the same turn resumes with the result and completes once.
 */
export default defineEval({
  description:
    "A root session's held turn shows a waiting boundary and completes once, at its end.",
  async test(t) {
    const turn = await t.send("WORKFLOW-STAGE-HOLD");
    turn.expectOk();

    turn.event("message.completed", {
      count: 1,
      data: { finishReason: "stop", message: STAGE_INTERIM_MESSAGE },
    });
    turn.event("session.waiting", { count: 1, data: HELD_TURN });
    turn.eventOrder([
      { data: { message: STAGE_INTERIM_MESSAGE }, type: "message.completed" },
      { data: HELD_TURN, type: "session.waiting" },
      { data: { status: "completed" }, type: "task.settled" },
      { data: { message: /^WORKFLOW-STAGE-RESULT / }, type: "message.completed" },
      { type: "turn.completed" },
    ]);
    turn.event("turn.started", { count: 1 });
    turn.event("turn.completed", { count: 1 });
    turn.eventsSatisfy("the held turn resumes under its own id", staysInOneTurn);
    turn.notCalledTool("task_wait");
    turn.messageIncludes('"plan":"deploy api"');
    t.noFailedActions();
  },
});
