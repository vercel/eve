import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

/** The id the scripted model gives its `eve__execute` call; nested calls take `<id>/<n>`. */
const PROGRAM_CALL = "specialist-program";

export default defineEval({
  description:
    "A program asks a deferred subagent about two disputes at once: each call opens its own child session, owned by its nested call id, and resolves to the agent's reply with no task.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("PROGRAM-SPECIALISTS Alice asks the specialist about two disputes.");

    turn.expectOk();
    turn.noFailedCalls();
    // Each agent call is reported under the agent's name, with the reply the program received.
    turn.calledTool("billing_specialist", {
      count: 1,
      input: { message: "Review Bob's dispute DSP-17." },
      output: "SPECIALIST-REVIEW: refund DSP-17",
    });
    turn.calledTool("billing_specialist", {
      count: 1,
      input: { message: "Review Alice's dispute DSP-18." },
      output: "SPECIALIST-REVIEW: no dispute named",
    });
    turn.event("child.opened", {
      count: 1,
      data: { name: "billing_specialist", owner: { callId: `${PROGRAM_CALL}/1` } },
    });
    turn.event("child.opened", {
      count: 1,
      data: { name: "billing_specialist", owner: { callId: `${PROGRAM_CALL}/2` } },
    });
    // A program awaits each reply; the model's task table never holds these calls.
    turn.notEvent("task.started");
    t.calledTool(EXECUTE_TOOL, {
      count: 1,
      output: {
        calls: { completed: 2 },
        result: ["SPECIALIST-REVIEW: refund DSP-17", "SPECIALIST-REVIEW: no dispute named"],
      },
    });
    t.messageIncludes(
      'PROGRAM-RESULT ["SPECIALIST-REVIEW: refund DSP-17","SPECIALIST-REVIEW: no dispute named"]',
    );
  },
});
