import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection_search";
const PETSTORE_INVENTORY_TOOL = "petstore__getInventory";

export default defineEval({
  tags: ["real-model"],
  description:
    "OpenAPI connection smoke: Swagger Petstore's Swagger 2.0 document exposes and calls getInventory.",

  async test(t) {
    const turn = await t.send(
      [
        "Use the `connection_search` tool to find the inventory operation in the `petstore` connection.",
        "Then call `petstore__getInventory` exactly once with an empty object.",
        "Reply with the exact words `inventory received` if the tool result contains inventory counts.",
      ].join("\n"),
    );

    turn.calledTool(PETSTORE_INVENTORY_TOOL, {
      output: hasInventoryCounts,
      count: 1,
    });

    t.succeeded();
    t.toolOrder([SEARCH_TOOL, PETSTORE_INVENTORY_TOOL]);
    t.calledTool(SEARCH_TOOL);
    t.calledTool(PETSTORE_INVENTORY_TOOL, {
      output: hasInventoryCounts,
      count: 1,
    });
    t.messageIncludes(/\binventory received\b/iu);
  },
});

function hasInventoryCounts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const body = (value as { body?: unknown }).body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  return Object.values(body).some((count) => typeof count === "number");
}
