import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { todo } from "eve/tools/todo";
import { z } from "zod";

const completionMarker = "SOURCE_ANALYSIS_COMPLETE";
const invocationCount = defineState("compaction-regression.perform-source-analysis", () => 0);

export default defineTool({
  description:
    "Compaction regression tool. Complete source analysis exactly once when the user requests the stale-todo-work case.",
  inputSchema: z.object({
    approach: z.string().min(1),
  }),
  async execute(input, ctx) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);
    await todo.execute(
      {
        todos: [{ content: "Complete source analysis", priority: "high", status: "pending" }],
      },
      ctx,
    );

    return {
      completed: true,
      completionMarker,
      workUnit: "source-analysis",
      hardStop: attempt >= 10,
      attempt,
      approach: input.approach,
      findings: [
        "The application entry point creates the request router and registers the catalog, cart, and checkout endpoints. Configuration is loaded before the first request is accepted.",
        "Catalog records contain a product identifier, display name, unit price, and availability flag. The repository returns an empty list when the catalog has no matching entries.",
        "Cart quantities are validated as positive integers. Adding an existing product updates its quantity, while removing the final item leaves a valid empty cart.",
        "Checkout calculates its total from the current catalog prices and cart quantities. Delivery charges are added after the subtotal, and currency values are represented in cents.",
        "The order repository stores the submitted items and total together. A generated order identifier is returned only after the write completes successfully.",
        "Order confirmation rendering uses the saved order data. Product names are rendered as text, and the template includes a summary of quantities, prices, and delivery details.",
        "The inventory service checks availability before accepting an order. If a product is unavailable, checkout returns an explanation and preserves the cart for correction.",
        "The address validator requires a recipient, street, city, and postal code. Optional address lines remain optional throughout validation and persistence.",
        "The notification adapter receives the order identifier after persistence. Delivery failures are recorded separately so they do not create a second order or discard the first one.",
        "The order history endpoint reads stored orders in reverse creation order. Pagination uses a bounded page size and returns a continuation cursor when more results are available.",
        "The cancellation handler checks the saved order status before updating it. Repeating a cancellation returns the existing cancelled state without repeating inventory adjustments.",
        "The reviewed modules cover the requested source analysis. The task list entry has not yet been updated, but no further source inspection is needed to report these findings.",
      ],
    };
  },
});
