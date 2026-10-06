import { defineEval } from "eve/evals";

// `search` finds the agent's own tools, not web pages, so a question about the
// world goes to `web_search` even while the catalog lists many entries.
export default defineEval({
  tags: ["real-model"],
  description: "A web question goes to web_search, not the catalog's search tool.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob is writing the team newsletter and wants one line of sports news.",
        "Please look up on the web who won the 2026 NBA Finals and tell him the winning team.",
      ].join(" "),
    );

    turn.expectOk();
    t.calledTool("web_search");
    t.notCalledTool("search");
    t.notCalledTool("execute");
  },
});
