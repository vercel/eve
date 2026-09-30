import { defineEval } from "eve/evals";

const PETSTORE_INVENTORY_TOOL = "petstore__getInventory";

export default defineEval({
  tags: ["real-model"],
  description:
    "A fixture-owned Swagger 2.0 document is searched and its getInventory called over HTTP.",

  async test(t) {
    const turn = await t.send(
      [
        "Use the `connection_search` tool to find the inventory operation in the `petstore` connection.",
        "Then call it with `connection_execute` and an empty input.",
        "Reply with the exact words `inventory received` if the tool result contains inventory counts.",
      ].join("\n"),
    );

    turn.calledTool(PETSTORE_INVENTORY_TOOL, { output: hasInventoryCounts });

    t.succeeded();
    t.toolOrder(["connection_search", "connection_execute"]);
    t.calledTool("connection_search");
    t.calledTool(PETSTORE_INVENTORY_TOOL, { output: hasInventoryCounts });
    t.messageIncludes(/\binventory received\b/iu);
  },
});

function hasInventoryCounts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const body = (value as { body?: unknown }).body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  return Object.values(body).some((count) => typeof count === "number");
}
