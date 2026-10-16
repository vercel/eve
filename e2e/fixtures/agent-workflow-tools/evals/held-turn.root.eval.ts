import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { STAGE_INTERIM_MESSAGE } from "../task-scenario-text";
import { staysInOneTurn } from "./held-turn.shared";

/**
 * The model starts `stage_deploy`, then ends its step with text instead of
 * waiting. The turn rule holds the turn: a person reads the text as a reply, the turn waits
 * on the task without a pause fact, and the same turn resumes with the result and completes
 * once. `send()` reads through the wait, so the turn's result is the final reply, not the text
 * written before it.
 */
export default defineEval({
  description: "A root session's held turn pauses and reports its final reply.",
  async test(t) {
    const turn = await t.send("WORKFLOW-STAGE-HOLD");
    turn.expectOk();

    turn.event("content.completed", {
      count: 1,
      data: { kind: "text", phase: "reply", value: STAGE_INTERIM_MESSAGE },
    });
    // Waiting on work isn't a fact: readers derive it with `waiting(view, turnId)`.
    turn.notEvent("turn.paused");
    turn.eventOrder([
      { data: { value: STAGE_INTERIM_MESSAGE }, type: "content.completed" },
      { data: { callId: "stage", outcome: "completed" }, type: "call.settled" },
      { data: { value: /^WORKFLOW-STAGE-RESULT / }, type: "content.completed" },
      { data: { outcome: "completed" }, type: "turn.settled" },
    ]);
    turn.event("turn.started", { count: 1 });
    turn.event("turn.settled", { count: 1 });
    turn.eventsSatisfy("the held turn resumes under its own id", staysInOneTurn);
    turn.notCalledTool("eve__task_wait");
    t.check(turn.message, includes(/^WORKFLOW-STAGE-RESULT \{.*"plan":"deploy api"/u)).label(
      "the turn's result is the final reply",
    );
    t.noFailedActions();
  },
});
