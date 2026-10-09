import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { STAGE_INTERIM_MESSAGE } from "../task-scenario-text";
import { staysInOneTurn } from "./held-turn.shared";

/**
 * The model starts `stage_deploy`, then ends its step with text instead of
 * waiting. The turn rule holds the turn: the text completes as an ordinary
 * reply, the stream reports `turn.paused`, and the same turn resumes with
 * the result and completes once. `send()` reads through the wait, so the
 * turn's result is the final reply, not the text written before it.
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
    turn.event("turn.paused", { count: 1 });
    turn.eventOrder([
      { data: { value: STAGE_INTERIM_MESSAGE }, type: "content.completed" },
      { type: "turn.paused" },
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
