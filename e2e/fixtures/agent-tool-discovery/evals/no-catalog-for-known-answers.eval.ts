import { defineEval } from "eve/evals";

import { calledTools, usesCatalog } from "./tool-use";

/** A question the model can answer itself doesn't send it to the catalog. */
export default defineEval({
  tags: ["real-model"],
  description: "A plain question is answered without eve__search or eve__execute.",

  async test(t) {
    const turn = await t.send(
      "Alice is converting a recipe for Bob. How many grams are in 3 ounces, rounded to the nearest gram?",
    );

    turn.expectOk();
    turn.eventsSatisfy("neither eve__search nor eve__execute is called", (events) =>
      calledTools(events).every((name) => !usesCatalog(name)),
    );
    t.messageIncludes(/\b85\b/u);
  },
});
