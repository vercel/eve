import { defineEval } from "eve/evals";

import { calledTools, usesCatalog } from "./tool-use";

/** A question about the world goes to `web_search`; `eve__search` only finds the agent's own tools. */
export default defineEval({
  tags: ["real-model"],
  description:
    "A question that needs current public information goes to web_search, not eve__search.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is preparing a short briefing for Bob and needs current public information.",
        "Please look up on the web the most recent stable release of Node.js and when it came out.",
      ].join(" "),
    );

    turn.expectOk();
    turn.eventsSatisfy("web_search is called, and the catalog isn't", (events) => {
      const called = calledTools(events);
      return called.includes("web_search") && !called.some(usesCatalog);
    });
  },
});
