import { defineEval } from "eve/evals";

const PETSTORE_INVENTORY_TOOL = "petstore__getInventory";

export default defineEval({
  description:
    "connection_execute calls a connection tool over HTTP and reports it as a nested action.",

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic mock model to issue the exact call.");
    }

    const turn = await t.send("PETSTORE_EXECUTE_E2E");

    turn.expectOk();
    turn.noFailedActions();
    turn.calledTool("connection_execute", { count: 1, output: hasInventoryCounts });
    turn.calledTool(PETSTORE_INVENTORY_TOOL, { count: 1, output: hasInventoryCounts });
    turn.event("actions.requested", {
      count: 1,
      data: {
        actions: [{ parentCallId: "petstore-inventory", toolName: PETSTORE_INVENTORY_TOOL }],
      },
    });
    t.succeeded();
    t.messageIncludes("inventory received");
  },
});

function hasInventoryCounts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const body = (value as { body?: unknown }).body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  return Object.values(body).some((count) => typeof count === "number");
}
