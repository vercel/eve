import { defineEval } from "eve/evals";

export default defineEval({
  description: "Provider tools smoke: gateway web search answers a current-events question.",
  async test(t) {
    const turn = await t.send("Who won the 2026 NBA finals");
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("web_search", { isError: false });
    t.noFailedActions();
    t.judge.autoevals
      .closedQA("The reply says that the New York Knicks won the 2026 NBA Finals.", {
        on: turn.message,
      })
      .atLeast(0.5);
  },
});
