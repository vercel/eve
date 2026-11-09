import { SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { OPEN_INCIDENTS } from "../agent/lib/catalog";

const TOOL = "sre__status_page_incidents_list";

/**
 * A request for a deferred tool's capability: the model searches its catalog
 * with eve__search, then runs the tool through eve__tool.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A request matching a namespaced deferred tool finds it with eve__search and runs it.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is starting her on-call shift and wants to know which incidents are open on our status page right now.",
        "Please check and give her each incident's id and title.",
      ].join(" "),
    );

    turn.expectOk();
    t.toolOrder([SEARCH_TOOL, TOOL]);
    t.calledTool(TOOL, { status: "completed" });
    t.messageIncludes(OPEN_INCIDENTS[0]!.id);
  },
});
