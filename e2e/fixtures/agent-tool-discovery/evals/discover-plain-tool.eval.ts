import { defineEval } from "eve/evals";

import { NEXT_RELEASE_TRAIN } from "../agent/lib/catalog";
import { SEARCH_TOOL } from "./tool-use";

const TOOL = "release_train_schedule";

/**
 * A deferred tool without a namespace, which the request describes but never
 * names: the model searches its catalog with eve__search, then runs the tool
 * through eve__execute.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A request matching a deferred tool without a namespace finds it with eve__search and runs it.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob is planning his week around the mobile app release.",
        "When does the next mobile release train depart, and who is its release captain?",
      ].join(" "),
    );

    turn.expectOk();
    t.toolOrder([SEARCH_TOOL, TOOL]);
    t.calledTool(TOOL, { status: "completed" });
    t.messageIncludes(NEXT_RELEASE_TRAIN.captain);
  },
});
