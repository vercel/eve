import { defineEval } from "eve/evals";

import {
  ASSISTANT_FINAL_AUDIT_PROMPT,
  ASSISTANT_FINAL_CASE_MARKER,
  ASSISTANT_FINAL_RESUMED_MARKER,
} from "../../agent/hitl-regression-constants";

export default defineEval({
  description: "Assistant-final resumed history gets a wire-only user continuation.",
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("This regression uses the fixture's deterministic mock model.");
    }

    const parked = await t.send(
      `${ASSISTANT_FINAL_CASE_MARKER}\nCall the gate tool once with marker "M1".`,
    );
    parked.calledTool("gate", { count: 1, status: "pending" });
    t.requireInputRequest({ toolName: "gate" });

    const resumed = await t.respondAll("approve");
    resumed.expectOk();
    resumed.event("action.result", {
      count: 1,
      data: {
        result: { kind: "tool-result", toolName: "gate" },
        status: "completed",
      },
    });

    // Whitespace normalizes to no user content, so durable history still ends
    // on the blank assistant message when the harness starts the model call.
    const probe = await t.send(" ");
    probe.expectOk();
    probe.messageIncludes(ASSISTANT_FINAL_RESUMED_MARKER);

    const audit = await t.send(ASSISTANT_FINAL_AUDIT_PROMPT);
    audit.expectOk();
    audit.messageIncludes("DURABLE_CONTINUATIONS:0");
    t.succeeded();
  },
});
