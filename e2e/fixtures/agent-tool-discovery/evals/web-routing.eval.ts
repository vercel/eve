import { defineEval } from "eve/evals";

import { calledTools, usesCatalog } from "./tool-use";

const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

/**
 * A question about the world goes to the web tools; `eve__search` only finds the agent's own tools.
 * Either web tool is a correct route: models answer this with `web_search` or by fetching a release index with `web_fetch`.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A question that needs current public information goes to web_search or web_fetch, not eve__search.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is preparing a short briefing for Bob and needs current public information.",
        "Please look up on the web the most recent stable release of Node.js and when it came out.",
      ].join(" "),
    );

    turn.expectOk();
    turn.eventsSatisfy("a web tool is called, and the catalog isn't", (events) => {
      const called = calledTools(events);
      return called.some((name) => WEB_TOOLS.has(name)) && !called.some(usesCatalog);
    });
  },
});
