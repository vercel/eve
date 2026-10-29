import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Looks up an order with get_order.",
  async test(t) {
    const session = await t.session({
      stubs: [{ id: "order", tool: "get_order", outcome: { response: { status: "shipped" } } }],
    });
    const turn = await session.send("Where is order 42?");
    t.succeeded();
    t.calledTool("get_order");
    t.check(turn.reply, includes("shipped"));
  },
});
