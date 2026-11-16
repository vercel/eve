import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

/**
 * The `research` tool rejects a message over its 15,000-character cap before any subagent runs.
 */
export default defineEval({
  description: "research refuses an over-long message.",
  async test(t) {
    const turn = await t.send(
      toolScript("research", { message: "x".repeat(15_001) })
    );
    turn.messageIncludes("Invalid input for tool research");
    t.notEvent("child.opened");
  },
});
