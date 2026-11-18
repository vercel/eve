import { defineState } from "eve/context";

/**
 * The turn in which `render_ui` last showed UI, so it runs once per turn. The
 * `reset-render-guard` hook clears it when the person sends a message or
 * answers a question or approval.
 */
export const lastRenderedTurn = defineState<{ readonly turnId: string | null }>(
  "ui.lastRenderedTurn",
  () => ({ turnId: null })
);
