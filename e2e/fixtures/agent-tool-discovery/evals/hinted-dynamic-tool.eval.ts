import { SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { CHARGER_UPTIME, LATE_TOOL } from "../agent/lib/catalog";

/**
 * A deferred tool a resolver adds on the second turn. eve's hint names it
 * without its description, so the model should search that exact name, which
 * it can only know from the hint, then run the tool.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A deferred tool added mid-session is found by an exact-name eve__search from the hint, then run.",

  async test(t) {
    const first = await t.send("Hi, I'm Dana from the fleet operations team.");
    first.expectOk();

    const turn = await first.session.send(
      "What was EV charger uptime at the Oakland depot this week, and which charger is offline?",
    );

    turn.expectOk();
    turn.toolOrder([SEARCH_TOOL, LATE_TOOL]);
    turn.calledTool(SEARCH_TOOL, {
      input: { query: (query) => typeof query === "string" && query.includes(LATE_TOOL) },
    });
    turn.calledTool(LATE_TOOL, { status: "completed" });
    turn.messageIncludes(CHARGER_UPTIME.offline);
  },
});
