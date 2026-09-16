import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_order_total";
const ORDER = {
  items: [
    { sku: "desk-lamp", unitPriceCents: 1200, quantity: 3 },
    { sku: "bulb-pack", unitPriceCents: 500, quantity: 2 },
  ],
  discountBps: 1250,
};

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod diagnoses incorrect quantity and discount calculations without regressing order boundaries.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      const before = await selfMod.verify(
        `Alice is checking an order. Call ${TOOL_NAME} once with ${JSON.stringify(ORDER)} and report the result as returned, without correcting it or changing the tool.`,
      );
      before.requireToolCall(TOOL_NAME, {
        input: ORDER,
        output: { subtotalCents: 1700, discountCents: 212, totalCents: 1488 },
      });

      await selfMod.request(
        [
          `Alice found a problem with ${TOOL_NAME}: three 1200-cent desk lamps and two 500-cent bulb packs with a 12.5% discount came back with a 1700-cent subtotal and a 1488-cent total.`,
          "The invoice should use quantities, then round the percentage discount down to whole cents: subtotal 4600, discount 575, total 4025.",
          "Please investigate and fix the tool for future orders rather than correcting just this response.",
          "Keep its existing input validation and calculation-only behavior; it must not place orders or charge customers.",
        ].join(" "),
      );
      await selfMod.assertOnlyChanged([`tools/${TOOL_NAME}.ts`]);
      await selfMod.apply();

      await Promise.all(
        (
          [
            [ORDER, 4600, 575],
            [
              {
                items: [{ sku: "monitor", unitPriceCents: 333, quantity: 3 }],
                discountBps: 3333,
              },
              999,
              332,
            ],
            [
              {
                items: [{ sku: "cable", unitPriceCents: 250, quantity: 1 }],
                discountBps: 0,
              },
              250,
              0,
            ],
            [{ items: [], discountBps: 5000 }, 0, 0],
          ] as const
        ).map(async ([input, subtotalCents, discountCents]) => {
          const turn = await selfMod.verify(
            `Call ${TOOL_NAME} once with ${JSON.stringify(input)} and report its result.`,
          );
          turn.requireToolCall(TOOL_NAME, {
            input,
            output: {
              subtotalCents,
              discountCents,
              totalCents: subtotalCents - discountCents,
            },
          });
        }),
      );
      t.succeeded();
    });
  },
});
