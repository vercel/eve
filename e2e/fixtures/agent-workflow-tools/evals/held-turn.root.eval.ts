import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { STAGE_INTERIM_MESSAGE } from "../task-scenario-text";
import { staysInOneTurn } from "./held-turn.shared";

/**
 * The model starts `stage_deploy`, then ends its step with text instead of
 * waiting. The turn rule holds the turn: the text completes as an ordinary
 * message, the stream reports `turn.waiting`, and the same turn resumes with
 * the result and completes once. `send()` reads through the wait, so the
 * turn's result is the final reply, not the text written before it.
 */
export default defineEval({
  description: "A root session's held turn parks with turn.waiting and reports its final reply.",
  async test(t) {
    const turn = await t.send("WORKFLOW-STAGE-HOLD");
    turn.expectOk();

    turn.event("message.completed", {
      count: 1,
      data: { finishReason: "stop", message: STAGE_INTERIM_MESSAGE },
    });
    turn.event("turn.waiting", { count: 1 });
    turn.eventOrder([
      { data: { message: STAGE_INTERIM_MESSAGE }, type: "message.completed" },
      { type: "turn.waiting" },
      { data: { status: "completed" }, type: "task.settled" },
      { data: { message: /^WORKFLOW-STAGE-RESULT / }, type: "message.completed" },
      { type: "turn.completed" },
    ]);
    turn.event("turn.started", { count: 1 });
    turn.event("turn.completed", { count: 1 });
    turn.eventsSatisfy("the held turn resumes under its own id", staysInOneTurn);
    turn.notCalledTool("eve__task_wait");
    t.check(turn.message, includes(/^WORKFLOW-STAGE-RESULT \{.*"plan":"deploy api"/u)).label(
      "the turn's result is the final reply",
    );
    t.noFailedActions();
  },
});
