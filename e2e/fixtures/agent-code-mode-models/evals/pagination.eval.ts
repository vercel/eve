import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { dataset } from "../src/data";
import { readEveryPage } from "../src/checks";
import { audit } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description: "The model saves the correct aggregate from every page of an orders export.",
  timeoutMs: 180_000,
  async test(t) {
    const turn = await t.send(
      "For the complete orders export, total and count all paid USD orders, excluding refunds and other currencies. Save the orders report with those results.",
    );
    const calls = await audit(t, turn);
    const { pages } = dataset(turn.sessionId);
    t.check(
      readEveryPage(
        calls,
        pages.map(({ cursor }) => cursor),
      ),
      equals(true),
    ).label("every page was successfully fetched");
    const paid = pages
      .flatMap(({ orders }) => orders)
      .filter((order) => order.status === "paid" && order.currency === "USD");
    t.check(
      calls
        .filter((call) => call.tool === "save_report" && call.status === "completed")
        .map((call) => call.input),
      equals([
        {
          report: {
            paidUsdCents: paid.reduce((total, order) => total + order.cents, 0),
            paidUsdOrders: paid.length,
          },
        },
      ]),
    ).label("the agent saved the filtered aggregate from every page");
  },
});
