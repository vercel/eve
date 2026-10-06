import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "execute rejects a misspelled tool name with the closest names, and the suggested name runs the tool.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-MISSPELLED Alice asks to refund invoice INV-2041.");

    turn.expectOk();
    // The misspelled call never reached a tool; only the corrected one ran.
    turn.calledTool("refund_invoice", {
      count: 1,
      input: { invoiceId: "INV-2041" },
      output: { invoiceId: "INV-2041", refunded: true },
    });
    t.messageIncludes('REFUND-RESULT {"invoiceId":"INV-2041","refunded":true}');
  },
});
