import { defineEval } from "eve/evals";

export default defineEval({
  description: "Provider tools smoke: gateway web search answers a current-events question.",
  async test(t) {
    const turn = await t.send("Who won the 2026 NBA finals");

    t.succeeded();
    t.calledTool("web_search");
    t.noFailedActions();
    t.messageIncludes(/New York Knicks/iu);
    t.judge.autoevals
      .factuality("The New York Knicks won the 2026 NBA Finals.", {
        on: turn.message,
      })
      .atLeast(0.5);
  },
});
