import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

// @ts-ignore TS6059: this eval intentionally exercises the workspace source implementation.
import { coalesceDeliverPayloads } from "../../../../../packages/eve/src/execution/deliver-payloads.js";

export default defineEval({
  description: "Delivery batching smoke: queued messages and context coalesce in arrival order.",
  async test(t) {
    const firstMessage = "Remember synthetic marker BATCH-FIRST.";
    const secondMessage = "Remember synthetic marker BATCH-SECOND.";
    const firstContext = "Synthetic context: first delivery.";
    const secondContext = "Synthetic context: second delivery.";

    await t.require(
      coalesceDeliverPayloads([
        { context: [firstContext], message: firstMessage },
        { context: [secondContext], message: secondMessage },
      ]),
      equals({
        context: [firstContext, secondContext],
        message: `${firstMessage}\n\n${secondMessage}`,
      }),
    );

    t.succeeded();
  },
});
