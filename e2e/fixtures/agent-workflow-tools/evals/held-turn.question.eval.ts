import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

import { staysInOneTurn } from "./held-turn.shared";

/**
 * `approve_rollout` is a task that asks a person to approve the rollout. The
 * model ends its step while the task works, so the turn holds, and the task's
 * question parks the open turn: `interaction.opened`, then `turn.paused`, with
 * no turn end. `send()` stops there because a question is pending; answering
 * it resumes the same turn, which completes once with the task's result.
 */
export default defineEval({
  description:
    "A task's question during a held turn parks the turn, which completes once answered.",
  async test(t) {
    const parked = await t.send("WORKFLOW-ROLLOUT-HOLD");
    t.check(parked.status, equals("waiting")).label("send() stops at the pending question");
    // The hold may pause the turn before or after the task asks; the question's
    // pause, which settles the message as awaiting input, is what ends `send()`.
    parked.eventsSatisfy("the task's question parks the open turn", (events) => {
      const question = events.findIndex(
        (event) => event.type === "interaction.opened" && event.scope?.taskId !== undefined,
      );
      const awaiting = events.findIndex(
        (event) => event.type === "delivery.settled" && event.data.outcome === "awaiting-input",
      );
      return question >= 0 && awaiting > question;
    });
    parked.notEvent("turn.settled");
    const request = parked.session.requireInputRequest({ toolName: "approve_rollout" });

    const answered = await parked.session.respond([
      { optionId: "approve", requestId: request.requestId },
    ]);
    answered.expectOk();
    answered.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.requestId, outcome: "accepted" },
    });
    answered.event("call.settled", {
      count: 1,
      data: { callId: "rollout", outcome: "completed", output: { approved: true, service: "api" } },
    });
    answered.notEvent("turn.started");
    answered.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    t.check(answered.message, includes(/^WORKFLOW-ROLLOUT-RESULT \{"approved":true/u)).label(
      "the answered turn's result is the final reply",
    );

    t.event("turn.started", { count: 1 });
    t.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    t.eventsSatisfy("the parked turn resumes under its own id", staysInOneTurn);
    t.noFailedActions();
  },
});
