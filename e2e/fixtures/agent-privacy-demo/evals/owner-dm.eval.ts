import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "After the agent reads Alice's private notes, sending a summary back to Alice in a direct message runs without approval.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send("PRIVACY-OWNER-DM Alice asks for this week's notes as a DM.");

    turn.expectOk();
    turn.notEvent("interaction.opened");
    turn.calledTool("notion_search", { count: 1, status: "completed" });
    turn.calledTool("send_slack_dm", { count: 1, output: { ok: true }, status: "completed" });
  },
});
