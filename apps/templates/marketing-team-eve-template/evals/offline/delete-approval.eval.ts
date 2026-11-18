import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

export default defineEval({
  description:
    "a specialist's delete_asset parks for approval and is rejected when denied.",
  async test(t) {
    const { session } = await t.send(
      toolScript("seo", {
        message: toolScript("delete_asset", {
          url: "https://example.private.blob.vercel-storage.com/drafts/post.md",
        }),
      })
    );
    session.requireInteraction({
      optionIds: ["approve", "deny"],
      toolName: "delete_asset",
    });

    await session.respondAll("deny");
    t.calledAgent("seo", {
      output: (value) => {
        const text =
          typeof value === "string" ? value : String(JSON.stringify(value));
        return !text.includes('"deleted":true');
      },
    });
  },
});
