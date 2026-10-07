import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

const INVENTORY_TOOL = "petstore__getInventory";

export default defineEval({
  description:
    "search lists an OpenAPI connection's operations, and execute calls one over HTTP under its full name.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("PETSTORE_EXECUTE_E2E");

    turn.expectOk();
    turn.noFailedActions();
    t.toolOrder(["search", INVENTORY_TOOL]);
    turn.calledTool("search", {
      count: 1,
      input: { query: "petstore__" },
      output: (value) => JSON.stringify(value).includes(`"tool":"${INVENTORY_TOOL}"`),
    });
    // The call is reported under the entry's name, never as a nested execute action.
    turn.calledTool(INVENTORY_TOOL, { count: 1, output: hasInventoryCounts });
    turn.notEvent("actions.requested", { data: { actions: [{ toolName: "execute" }] } });
    t.messageIncludes("inventory received");
  },
});

function hasInventoryCounts(value: unknown): boolean {
  const body = (value as { body?: unknown } | null)?.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  return Object.values(body).some((count) => typeof count === "number");
}
