import { expectCacheReuse, expectHealthyTurn } from "@eve-e2e/config/cache-checks";
import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { ledgerNotes } from "../ledger-notes";

// A program's nested calls never reach history or the tool list: the model reads one result
// for its eve__execute call. So every request after the first still reads the preceding one
// from the provider cache, as it does after discovery (see cache-after-discovery.eval.ts).
export default defineEval({
  tags: ["real-model"],
  description:
    "Running an eve__execute program over deferred tools and a connection tool keeps the prompt cache.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is reconciling the billing desk's weekly ledger notes below.",
        "For her report she needs three figures from the desk's tools: the status of invoice INV-2041, the US west regional ledger balance for 2026-09, and how many pets the pet store has available.",
        "Please collect all three in one eve__execute program, so the lookups stay out of the conversation, and return the three figures from it.",
        "Then tell Alice the three figures in two sentences.",
        "",
        ledgerNotes(),
      ].join("\n"),
    );

    expectHealthyTurn(turn);
    turn.calledTool(EXECUTE_TOOL);
    turn.calledTool("lookup_invoice", { input: { invoiceId: "INV-2041" } });
    turn.calledTool("ledger__us_west", { input: { month: "2026-09" } });
    turn.calledTool("petstore__getInventory");
    turn.eventsSatisfy("the three lookups ran inside a program", (events) =>
      ["lookup_invoice", "ledger__us_west", "petstore__getInventory"].every((name) =>
        events.some(
          (event) =>
            event.type === "call.requested" &&
            event.data.capability.name === name &&
            "callId" in event.data.owner,
        ),
      ),
    );
    turn.notEvent("context.settled", { data: { kind: "compaction", outcome: "completed" } });
    expectCacheReuse(t, [turn]);
  },
});
