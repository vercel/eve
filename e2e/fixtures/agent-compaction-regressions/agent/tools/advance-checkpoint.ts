import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { SECOND_CHECKPOINT_MARKER } from "../../constants";

const invocationCount = defineState("compaction-regression.advance-checkpoint", () => 0);

export default defineTool({
  description:
    "Record the handoff notes after the initial review is complete and return its checkpoint marker.",
  inputSchema: z.object({
    regressionCase: z.enum(["redundant-tool-calls", "stale-todo-work"]),
  }),
  async execute(input) {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      checkpointMarker: SECOND_CHECKPOINT_MARKER,
      completed: true,
      regressionCase: input.regressionCase,
      attempt,
      handoffNotes: [
        "Alice has finished the initial review of the online shop. Bob will use these notes to prepare the team handoff. The completed review remains the source for the findings; preparing the handoff does not require another inspection.",
        "The catalog, cart, and checkout form the main customer journey. The handoff groups the findings in that order so Bob can follow a product from the catalog through the cart and into a saved order without jumping between unrelated topics.",
        "Catalog notes cover product identifiers, names, prices, and availability. Bob can use that section to explain which values the cart displays and which values checkout reads again when it calculates the final order total.",
        "Cart notes cover adding items, changing quantities, and removing the last item. An empty cart is an ordinary state. The handoff distinguishes an empty cart from an invalid quantity so the examples remain clear to the next reviewer.",
        "Checkout notes separate the subtotal from delivery charges and describe amounts in cents. The recorded order contains both the submitted items and the calculated total, giving the confirmation page a consistent saved result to display.",
        "The confirmation section explains that the saved order supplies the displayed quantities, prices, and delivery details. Notification delivery is a separate follow-up to saving the order, so a delayed notification does not mean the purchase was lost.",
        "Inventory and address validation are listed with the checkout findings. When a customer needs to correct either one, the cart remains available. Bob can refer to these notes when describing the expected correction flow to the team.",
        "The order history section records how stored orders are listed and paginated. The cancellation section records how repeated cancellation requests use the saved order status. These are existing review findings, not additional work requests.",
        "Bob maintains the shared task list independently of Alice's review. A pending review entry means that the list has not been updated yet. The successful tool result records that the review itself is complete, and Bob will reconcile the list during handoff.",
        "The handoff notes are now recorded and the checkpoint marker identifies this completed step. The remaining response should report the review completion marker and this checkpoint marker so Alice and Bob can locate both completed results.",
      ],
    };
  },
});
