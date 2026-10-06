import { defineEval } from "eve/evals";

const INVENTORY_TOOL = "petstore-approval__getInventory";

export default defineEval({
  description:
    "A connection's approval asks about the connection tool by its own name, and the call runs once approved.",

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic mock model to issue the exact call.");
    }

    const parked = await t.send("PETSTORE_APPROVAL_E2E");
    const session = parked.session;
    parked.expectOk();

    session.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: INVENTORY_TOOL,
    });
    parked.calledTool(INVENTORY_TOOL, { count: 1, status: "pending" });
    parked.notEvent("action.result", { data: { result: { toolName: INVENTORY_TOOL } } });

    const approved = await session.respondAll("approve");

    approved.expectOk();
    approved.noFailedActions();
    approved.calledTool(INVENTORY_TOOL, { count: 1, status: "completed" });
    t.messageIncludes("inventory received");
  },
});
