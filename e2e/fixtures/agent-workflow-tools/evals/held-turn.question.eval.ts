import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

import { staysInOneTurn } from "./held-turn.shared";

/**
 * `approve_rollout` is a task that asks a person to approve the rollout. The
 * model ends its step while the task works, so the turn holds, and the task's
 * question parks the open turn: `input.requested`, then `turn.waiting`, with
 * no turn end. `send()` stops there because a question is pending; answering
 * it resumes the same turn, which completes once with the task's result.
 */
export default defineEval({
  description:
    "A task's question during a held turn parks the turn, which completes once answered.",
  async test(t) {
    const parked = await t.send("WORKFLOW-ROLLOUT-HOLD");
    t.check(parked.status, equals("waiting")).label("send() stops at the pending question");
    // The hold may park the turn before or after the task asks; the question's
    // own `turn.waiting` is what ends `send()`.
    parked.eventsSatisfy("the task's question parks the open turn", (events) => {
      const question = events.findIndex(
        (event) => event.type === "input.requested" && event.data.taskId !== undefined,
      );
      return question >= 0 && events.at(-1)?.type === "turn.waiting";
    });
    parked.notEvent("turn.completed");
    parked.notEvent("session.waiting");
    const request = parked.session.requireInputRequest({ toolName: "approve_rollout" });

    const answered = await parked.session.respond([
      { optionId: "approve", requestId: request.requestId },
    ]);
    answered.expectOk();
    answered.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "answered", requestId: request.requestId }] },
    });
    answered.event("task.settled", {
      count: 1,
      data: { callId: "rollout", output: { approved: true, service: "api" }, status: "completed" },
    });
    answered.notEvent("turn.started");
    answered.event("turn.completed", { count: 1 });
    t.check(answered.message, includes(/^WORKFLOW-ROLLOUT-RESULT \{"approved":true/u)).label(
      "the answered turn's result is the final reply",
    );

    t.event("turn.started", { count: 1 });
    t.event("turn.completed", { count: 1 });
    t.eventsSatisfy("the parked turn resumes under its own id", staysInOneTurn);
    t.noFailedActions();
  },
});
