import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

/**
 * `delete_asset` waits for the user's approval, and a denial means it never runs.
 */
export default defineEval({
  description: "delete_asset parks for approval and is rejected when denied.",
  async test(t) {
    const { session } = await t.send(
      toolScript("delete_asset", {
        url: "https://example.public.blob.vercel-storage.com/drafts/post.md",
      })
    );
    session.requireInteraction({
      optionIds: ["approve", "deny"],
      toolName: "delete_asset",
    });

    await session.respondAll("deny");
    t.calledTool("delete_asset", { count: 1, status: "rejected" });
  },
});
