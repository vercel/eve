import { defineEval } from "eve/evals";

import { ledgerNotes } from "../ledger-notes";
import { expectCacheReuse, expectHealthyTurn } from "./cache-checks";

// Discovering and calling a deferred tool never adds a definition, so every
// request after the first reads the preceding one from the provider cache.
export default defineEval({
  tags: ["real-model"],
  description: "Finding and calling a deferred tool keeps the provider prompt cache.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is reconciling the billing desk's weekly ledger notes below.",
        "Invoice INV-2041 was paid twice by mistake, so please refund it in full with the desk's tools,",
        "then tell Alice in one sentence that the refund is done.",
        "",
        ledgerNotes(),
      ].join("\n"),
    );

    expectHealthyTurn(turn);
    turn.calledTool("refund_invoice", { count: 1, input: { invoiceId: "INV-2041" } });
    turn.notEvent("compaction.completed");
    expectCacheReuse(t, turn);
  },
});
