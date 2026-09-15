import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_shipping_quote";

export default defineEval({
  tags: ["real-model"],
  description:
    "A generated shipping tool applies destination, weight, threshold, and expedited pricing rules.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      await selfMod.request(
        [
          `Alice needs a reusable ${TOOL_NAME} action for preparing order quotes in future conversations.`,
          "Accept subtotalCents as an integer from 0 through 1000000, weightGrams as an integer from 1 through 50000, destination as domestic or international, and expedited as a boolean.",
          "Domestic standard shipping is 500 cents plus 100 cents for each started kilogram. Waive that entire standard charge when the subtotal is at least 5000 cents.",
          "International standard shipping is 1500 cents plus 300 cents for each started kilogram and is never waived.",
          "Expedited delivery adds 1200 cents after calculating the standard charge, including when domestic standard shipping is waived.",
          "Return structured data with standardShippingCents, expeditedSurchargeCents, shippingCents, and totalCents.",
          "This action only calculates a quote. It must not place orders, charge customers, or contact external services.",
        ].join(" "),
      );
      await selfMod.readSource(`tools/${TOOL_NAME}.ts`);
      await selfMod.assertOnlyChanged([`tools/${TOOL_NAME}.ts`]);
      await selfMod.apply();

      for (const [input, standardShippingCents, expeditedSurchargeCents] of [
        [
          { subtotalCents: 4999, weightGrams: 1000, destination: "domestic", expedited: false },
          600,
          0,
        ],
        [
          { subtotalCents: 5000, weightGrams: 1001, destination: "domestic", expedited: false },
          0,
          0,
        ],
        [
          { subtotalCents: 5000, weightGrams: 1001, destination: "domestic", expedited: true },
          0,
          1200,
        ],
        [
          {
            subtotalCents: 10000,
            weightGrams: 2001,
            destination: "international",
            expedited: false,
          },
          2400,
          0,
        ],
        [
          {
            subtotalCents: 2500,
            weightGrams: 1,
            destination: "international",
            expedited: true,
          },
          1800,
          1200,
        ],
      ] as const) {
        const shippingCents = standardShippingCents + expeditedSurchargeCents;
        const turn = await selfMod.verify(
          `Please use ${TOOL_NAME} once to quote this order: ${JSON.stringify(input)}. Report the quote without placing an order.`,
        );
        turn.requireToolCall(TOOL_NAME, {
          input,
          output: {
            standardShippingCents,
            expeditedSurchargeCents,
            shippingCents,
            totalCents: input.subtotalCents + shippingCents,
          },
        });
      }
      t.succeeded();
    });
  },
});
