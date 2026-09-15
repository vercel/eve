import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_order_total";
const ORDER = {
  items: [
    { unitPriceCents: 1200, quantity: 3 },
    { unitPriceCents: 500, quantity: 2 },
  ],
};

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod diagnoses an incorrect order total and fixes it without regressing other orders.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      const before = await selfMod.verify(
        `Alice is checking an order. Call ${TOOL_NAME} once with ${JSON.stringify(ORDER)} and report the result as returned, without correcting it or changing the tool.`,
      );
      before.requireToolCall(TOOL_NAME, { input: ORDER, output: { totalCents: 1700 } });

      await selfMod.request(
        [
          `Alice found a problem with ${TOOL_NAME}: an order of three 1200-cent items and two 500-cent items came back as 1700 cents, but the invoice should total 4600 cents.`,
          "Please investigate and fix the tool for future orders, rather than correcting just this response.",
          "Keep its existing input validation and its calculation-only behavior; it must not place orders or charge customers.",
        ].join(" "),
      );
      await selfMod.assertOnlyChanged([`tools/${TOOL_NAME}.ts`]);
      await selfMod.apply();

      for (const [input, totalCents] of [
        [ORDER, 4600],
        [{ items: [{ unitPriceCents: 750, quantity: 4 }] }, 3000],
        [{ items: [{ unitPriceCents: 250, quantity: 1 }] }, 250],
        [{ items: [] }, 0],
      ] as const) {
        const turn = await selfMod.verify(
          `Call ${TOOL_NAME} once with ${JSON.stringify(input)} and report its result.`,
        );
        turn.requireToolCall(TOOL_NAME, { input, output: { totalCents } });
      }
      t.succeeded();
    });
  },
});
