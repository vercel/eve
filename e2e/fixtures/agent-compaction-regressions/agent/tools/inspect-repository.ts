import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const completionMarker = "REPOSITORY_INSPECTION_COMPLETE";
const invocationCount = defineState("compaction-regression.inspect-repository", () => 0);

export default defineTool({
  description:
    "Inspect the online shop repository and return an overview of its modules for the review handoff.",
  inputSchema: z.object({
    scope: z.literal("repository"),
  }),
  async execute() {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      completed: true,
      completionMarker,
      workUnit: "repository-inspection",
      hardStop: attempt >= 10,
      attempt,
      findings: [
        "The repository contains a small online shop. The application entry point loads configuration, constructs the request router, and connects the catalog, cart, checkout, and order history handlers to their repositories.",
        "The catalog module owns product records with identifiers, display names, unit prices, and availability flags. Its repository provides product lookup and filtered listing, returning an empty list when a filter has no matching records.",
        "The cart module stores product identifiers and quantities for each customer cart. Its handlers validate positive integer quantities, combine additions for an existing product, and allow the final item to be removed without invalidating the cart.",
        "The checkout module reads current product prices and availability before calculating the order. It combines item quantities with prices represented in cents, adds delivery charges, and passes the resulting items and total to the order repository.",
        "The order repository stores an order and its submitted items together. It returns the generated order identifier after persistence completes. The confirmation handler then reads the saved record instead of reconstructing the order from the cart.",
        "The confirmation templates display product names, quantities, item prices, and delivery details from the saved order. Product names are rendered as text. The templates share formatting helpers for currency values and postal addresses.",
        "The inventory service checks whether requested quantities are available before checkout accepts an order. When availability has changed, the handler explains which cart entry needs attention and keeps the other entries available for correction.",
        "The address validation module requires a recipient, street, city, and postal code. An additional address line is optional. The same validated address shape flows through checkout, persistence, and order confirmation rendering.",
        "The notification adapter receives an order identifier after the order is saved. It records delivery outcomes separately from order creation, allowing the application to report a delayed confirmation without creating the purchase again.",
        "The order history module reads saved orders in reverse creation order. Its repository uses bounded page sizes and a continuation cursor. The response includes the saved order status, item summary, and total for each returned entry.",
        "The cancellation handler reads the saved order status before applying an update. An already cancelled order returns its existing state. Inventory adjustments are associated with the first successful cancellation rather than every repeated request.",
        "The repository overview is complete and ready for Alice's handoff to Bob. The modules above cover the requested customer journey, including ordinary empty states, validation failures, saved results, and follow-up notifications.",
      ],
    };
  },
});
