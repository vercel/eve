import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

/**
 * A preference saved in one session is recalled into the next.
 */
export default defineEval({
  description: "file memory carries a saved preference into a new session.",
  async test(t) {
    await t.send(
      toolScript("preferences__save_memory", {
        text: "Prefers British spelling.",
      })
    );
    t.calledTool("preferences__save_memory");

    const next = await t.send("What do you remember about me?");
    next.messageIncludes("Prefers British spelling.");
  },
});
