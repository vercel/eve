import { defineHook } from "eve/hooks";
import { loadWorkspaceCredentials } from "../lib/workspace";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        await loadWorkspaceCredentials(ctx.session.auth.current);
      } catch (error) {
        // Without credentials every workspace tool call would fail; stop before the model runs.
        console.warn("cancelling turn: workspace credentials unavailable", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: ctx.session.id,
        });
        ctx.cancel();
      }
    },
  },
});
