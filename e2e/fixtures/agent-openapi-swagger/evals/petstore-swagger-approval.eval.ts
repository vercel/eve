import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection_search";
const PETSTORE_APPROVAL_INVENTORY_TOOL = "petstore-approval__getInventory";

export default defineEval({
  tags: ["real-model"],
  description:
    "An approval-gated operation from a fixture-owned Swagger 2.0 document parks before execution.",

  async test(t) {
    const parked = await t.send(
      [
        "Use the `connection_search` tool with connection `petstore-approval` to find the inventory operation.",
        "Then call it with `connection_execute` and an empty input.",
        "Wait for approval if requested.",
        "After the tool runs, reply with the exact words `inventory received` if the tool result contains inventory counts.",
      ].join("\n"),
    );
    const session = parked.session;
    parked.expectOk();

    // The approval belongs to the model's connection_execute call.
    session.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "connection_execute",
    });
    parked.calledTool("connection_execute", { status: "pending", count: 1 });
    parked.notEvent("action.result", {
      data: { result: { toolName: PETSTORE_APPROVAL_INVENTORY_TOOL } },
    });

    const approved = await session.respondAll("approve");
    approved.expectOk();

    approved.event("action.result", {
      data: {
        result: { kind: "tool-result", toolName: PETSTORE_APPROVAL_INVENTORY_TOOL },
        status: "completed",
      },
    });

    t.succeeded();
    t.calledTool(SEARCH_TOOL);
    t.calledTool(PETSTORE_APPROVAL_INVENTORY_TOOL, {
      output: hasInventoryCounts,
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
