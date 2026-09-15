import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_shipping_quote";

export default defineEval({
  tags: ["real-model"],
  description:
    "A generated shipping tool calculates quotes at both sides of the free-shipping threshold.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      await selfMod.request(
        [
          `Alice needs a reusable ${TOOL_NAME} action for preparing order quotes in future conversations.`,
          "Accept subtotalCents as an integer from 0 through 1000000 and expedited as a boolean.",
          "Standard shipping costs 500 cents for subtotals below 5000 cents and is free otherwise.",
          "Expedited delivery adds 1200 cents to that shipping charge, including on orders with free standard shipping.",
          "Return structured data with shippingCents and totalCents (subtotal plus shipping).",
          "This action only calculates a quote. It must not place orders, charge customers, or contact external services.",
        ].join(" "),
      );
      await selfMod.readSource(`tools/${TOOL_NAME}.ts`);
      await selfMod.assertOnlyChanged([`tools/${TOOL_NAME}.ts`]);
      await selfMod.apply();

      for (const [subtotalCents, expedited, shippingCents] of [
        [0, false, 500],
        [4999, false, 500],
        [5000, false, 0],
        [5000, true, 1200],
        [2500, true, 1700],
      ] as const) {
        const input = { subtotalCents, expedited };
        const turn = await selfMod.verify(
          `Please use ${TOOL_NAME} once to quote this order: ${JSON.stringify(input)}. Report the quote without placing an order.`,
        );
        turn.requireToolCall(TOOL_NAME, {
          input,
          output: { shippingCents, totalCents: subtotalCents + shippingCents },
        });
      }
      t.succeeded();
    });
  },
});
