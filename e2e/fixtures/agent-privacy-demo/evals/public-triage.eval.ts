import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "After the agent reads a public issue but nothing private, posting a triage note runs without approval: untrusted content alone, with no confidential data to leak.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send("PRIVACY-TRIAGE Alice asks the agent to triage public issue 42.");

    turn.expectOk();
    turn.notEvent("interaction.opened");
    turn.calledTool("read_public_issue", { count: 1, status: "completed" });
    turn.calledTool("post_to_slack", { count: 1, output: { ok: true }, status: "completed" });
  },
});
