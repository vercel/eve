import { defineHook, type HookContext } from "eve/hooks";

interface WorkspaceCredentials {
  readonly token: string;
}

/** Stands in for a credential store lookup that fails when the caller's grant was revoked. */
async function loadWorkspaceCredentials(ctx: HookContext): Promise<WorkspaceCredentials> {
  if (ctx.session.auth.current?.attributes.workspaceCredentials === "revoked") {
    throw new Error("The workspace grant for this caller was revoked.");
  }
  return { token: "fixture-workspace-token" };
}

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        await loadWorkspaceCredentials(ctx);
      } catch (error) {
        // Without credentials every tool call would fail; stop before the model runs.
        console.warn("cancelling turn: workspace credentials unavailable", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: ctx.session.id,
        });
        ctx.cancel();
      }
    },
  },
});
