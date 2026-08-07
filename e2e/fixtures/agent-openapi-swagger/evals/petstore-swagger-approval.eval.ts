import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection_search";
const PETSTORE_APPROVAL_INVENTORY_TOOL = "petstore-approval__getInventory";

export default defineEval({
  tags: ["real-model"],
  description:
    "OpenAPI connection HITL: an approval-gated Swagger Petstore operation parks before execution.",

  async test(t) {
    const parked = await t.send(
      [
        "Use the `connection_search` tool with connection `petstore-approval` to find the inventory operation.",
        "Then call `petstore-approval__getInventory` exactly once with an empty object.",
        "Wait for approval if requested.",
        "After the tool runs, reply with the exact words `inventory received` if the tool result contains inventory counts.",
      ].join("\n"),
    );
    parked.expectOk();

    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: PETSTORE_APPROVAL_INVENTORY_TOOL,
    });
    parked.calledTool(PETSTORE_APPROVAL_INVENTORY_TOOL, { status: "pending", count: 1 });

    const approved = await t.respondAll("approve");
    approved.expectOk();

    approved.event("action.result", {
      data: {
        result: { kind: "tool-result", toolName: PETSTORE_APPROVAL_INVENTORY_TOOL },
        status: "completed",
      },
      count: 1,
    });

    t.succeeded();
    t.calledTool(SEARCH_TOOL);
    t.calledTool(PETSTORE_APPROVAL_INVENTORY_TOOL, {
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
