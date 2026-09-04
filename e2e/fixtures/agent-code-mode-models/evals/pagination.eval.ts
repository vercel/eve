import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { dataset } from "../src/data";
import { parseAnswer, readEveryPage } from "../src/checks";
import { audit } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description: "The model computes a complete paginated aggregate within one Code Mode program.",
  timeoutMs: 180_000,
  async test(t) {
    const turn = await t.send(
      "For the complete orders export, total all paid USD orders, excluding refunds and other currencies. Return JSON with paidUsdCents (integer cents) and paidUsdOrders (count).",
    );
    const calls = await audit(t, turn);
    const { pages } = dataset(turn.sessionId);
    t.check(
      readEveryPage(
        calls,
        pages.map(({ cursor }) => cursor),
      ),
      equals(true),
    ).label("every page was fetched using its returned cursor");
    const paid = pages
      .flatMap(({ orders }) => orders)
      .filter((order) => order.status === "paid" && order.currency === "USD");
    t.check(
      parseAnswer(turn.message),
      equals({
        paidUsdCents: paid.reduce((total, order) => total + order.cents, 0),
        paidUsdOrders: paid.length,
      }),
    ).label("the answer includes the filtered aggregate from every page");
  },
});
