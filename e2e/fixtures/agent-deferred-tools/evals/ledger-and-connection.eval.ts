import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "search finds a deferred tool a session-scoped resolver returned, execute runs it, and execute calls an OpenAPI connection tool.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-LEDGER Alice asks for the west ledger and pet inventory.");

    turn.expectOk();
    turn.noFailedActions();
    t.toolOrder(["search", "ledger__us_west", "petstore__getInventory"]);
    turn.calledTool("ledger__us_west", {
      count: 1,
      output: { balance: 1000, month: "2026-09", region: "us_west" },
    });
    turn.calledTool("petstore__getInventory", {
      count: 1,
      output: { body: { available: 7, pending: 2, sold: 3 }, status: 200 },
    });
  },
});
