import { defineHook } from "eve/hooks";

import { lastRenderedTurn } from "../lib/ui-state";

/**
 * Clears the `render_ui` guard when the person sends a message or answers a
 * question or approval, so the agent can show UI again within the same turn.
 */
export default defineHook({
  events: {
    "interaction.settled"() {
      resetRenderGuard();
    },
    "delivery.consumed"() {
      resetRenderGuard();
    },
  },
});

function resetRenderGuard() {
  lastRenderedTurn.update(() => ({ turnId: null }));
}
