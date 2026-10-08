import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["session-inbox"],
  description: "The stock-price subagent returns a stubbed quote after approval.",
  timeoutMs: 90_000,
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "quote",
          tool: "stock-price/get_stock_price",
          outcome: { response: { price: 314.15 } },
        },
      ],
    });
    let turn = await session.send(
      "Call the stock-price subagent exactly once to look up GOOG's price.",
    );
    for (let attempt = 0; attempt < 5 && !turn.message?.includes("314.15"); attempt += 1) {
      const current = turn.session;
      if (current.pendingInputRequests.length > 0) {
        current.requireInputRequest({ toolName: "get_stock_price" });
        turn = await current.respondAll("approve");
      } else {
        turn = await t.target
          .watchTurn(current.sessionId, { startIndex: current.state.streamIndex })
          .result();
      }
      turn.expectOk();
    }
    turn.messageIncludes("314.15");
    t.calledSubagent("stock-price", { status: "completed", count: 1 });
    t.noFailedActions();
  },
});
