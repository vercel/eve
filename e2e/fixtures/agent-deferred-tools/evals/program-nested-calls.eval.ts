import { CALL_TOOL, EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

/** The id the scripted model gives its `eve__execute` call; nested calls take `<id>/<n>`. */
const PROGRAM_CALL = "ledger-program";

export default defineEval({
  description:
    "One eve__execute program calls a deferred tool, a session-scoped deferred tool, and an OpenAPI connection tool: each is reported under its own name as a call the program's call owns, and the model reads one value.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send(
      "PROGRAM-LEDGER Alice asks for an invoice, the west ledger, and pet stock.",
    );

    turn.expectOk();
    turn.noFailedCalls();
    t.calledTool(EXECUTE_TOOL, {
      count: 1,
      output: {
        calls: { completed: 3 },
        logs: ["checked INV-2041"],
        result: { available: 7, balance: 1000, status: "paid" },
      },
    });
    // Each nested call is reported under the entry's own name, with its own input and output.
    turn.calledTool("lookup_invoice", {
      count: 1,
      input: { invoiceId: "INV-2041" },
      output: { amount: 120, invoiceId: "INV-2041", status: "paid" },
    });
    turn.calledTool("ledger__us_west", {
      count: 1,
      output: { balance: 1000, month: "2026-09", region: "us_west" },
    });
    turn.calledTool("petstore__getInventory", {
      count: 1,
      output: { body: { available: 7, pending: 2, sold: 3 }, status: 200 },
    });
    turn.eventsSatisfy(
      "the program's call owns each nested call, under an id it derives",
      (events) => {
        const nested = events.flatMap((event) =>
          event.type === "call.requested" && event.data.capability.name !== EXECUTE_TOOL
            ? [`${event.data.callId} ${JSON.stringify(event.data.owner)}`]
            : [],
        );
        const owner = JSON.stringify({ callId: PROGRAM_CALL });
        return (
          JSON.stringify(nested.sort()) ===
          JSON.stringify([1, 2, 3].map((index) => `${PROGRAM_CALL}/${index} ${owner}`))
        );
      },
    );
    // A program reaches entries itself, so nothing goes through eve__tool.
    turn.notEvent("call.requested", { data: { capability: { name: CALL_TOOL } } });
    t.messageIncludes('PROGRAM-RESULT {"available":7,"balance":1000,"status":"paid"}');
  },
});
