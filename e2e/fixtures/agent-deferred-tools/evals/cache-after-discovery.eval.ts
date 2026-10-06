import { expectCacheReuse, expectHealthyTurn } from "@eve-e2e/config/cache-checks";
import { defineEval } from "eve/evals";

import { ledgerNotes } from "../ledger-notes";

// Discovering and calling deferred entries never adds a definition, so every
// request after the first reads the preceding one from the provider cache:
// an agent tool and a connection tool alike.
export default defineEval({
  tags: ["real-model"],
  description: "Finding and calling a deferred tool and a connection tool keeps the prompt cache.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is reconciling the billing desk's weekly ledger notes below.",
        "Invoice INV-2041 was paid twice by mistake, so please refund it in full with the desk's tools.",
        "Bob is adding the pet store's current stock to the same report, so please also check the pet store inventory.",
        "Then tell Alice in two sentences that the refund is done and what the inventory shows.",
        "",
        ledgerNotes(),
      ].join("\n"),
    );

    expectHealthyTurn(turn);
    turn.calledTool("refund_invoice", { count: 1, input: { invoiceId: "INV-2041" } });
    turn.calledTool("petstore__getInventory");
    turn.notEvent("compaction.completed");
    expectCacheReuse(t, [turn]);
  },
});
