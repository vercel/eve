import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

const INVENTORY_TOOL = "petstore-approval__getInventory";

export default defineEval({
  description:
    "A connection's approval asks about the connection tool by its own name, and the call runs once approved.",

  async test(t) {
    requireMockModel(t);

    const parked = await t.send("PETSTORE_APPROVAL_E2E");
    const session = parked.session;
    parked.expectOk();

    session.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: INVENTORY_TOOL,
    });
    parked.calledTool(INVENTORY_TOOL, { count: 1, status: "pending" });
    const inventoryCallId = parked.toolCalls.find((call) => call.name === INVENTORY_TOOL)?.callId;
    parked.notEvent("call.settled", { data: (data) => data.callId === inventoryCallId });

    const approved = await session.respondAll("approve");

    approved.expectOk();
    approved.noFailedActions();
    approved.calledTool(INVENTORY_TOOL, { count: 1, status: "completed" });
    t.messageIncludes("inventory received");
  },
});
