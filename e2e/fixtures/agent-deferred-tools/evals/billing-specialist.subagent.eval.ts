import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A deferred subagent called through eve__tool starts a child session that records the model's call id.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-SPECIALIST Alice asks the specialist about Bob's dispute.");

    turn.expectOk();
    turn.noFailedActions();
    t.calledSubagent("billing_specialist", {
      callId: "specialist",
      count: 1,
      output: "SPECIALIST-REVIEW: refund DSP-17",
      status: "completed",
    });
    turn.event("child.opened", {
      count: 1,
      data: { name: "billing_specialist", owner: { callId: "specialist" } },
    });
    t.messageIncludes("SPECIALIST-RESULT SPECIALIST-REVIEW: refund DSP-17");
  },
});
