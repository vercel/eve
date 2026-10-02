import { defineEval } from "eve/evals";

import { taskStarts } from "./task-events";

/**
 * A follow-up about the same research goes to the researcher that already
 * has the context: the model continues its task by taskId in the next turn
 * instead of starting a new researcher.
 */
export default defineEval({
  description: "The model continues an agent instead of starting a new one.",
  tags: ["real-model"],
  async test(t) {
    const first = await t.send(
      "Please ask the researcher how churn looked in EMEA for Q3 and tell me what it found.",
    );
    first.expectOk();

    const followUp = await first.session.send(
      "Thanks. Please follow up with the researcher: how does that compare with Q2 for the same region?",
    );
    followUp.expectOk();

    t.event("agent.started", { count: 1, data: { name: "researcher" } });
    t.eventsSatisfy("both turns reach one researcher task", (events) => {
      const calls = taskStarts(events, "researcher");
      return (
        calls.length >= 2 &&
        new Set(calls.map((call) => call.taskId)).size === 1 &&
        new Set(calls.map((call) => call.turnId)).size === 2
      );
    });
    followUp.messageIncludes(/Q2/u);
    t.noFailedActions();
  },
});
