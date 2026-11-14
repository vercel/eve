import { defineEval } from "eve/evals";
import { toolScript } from "../shared.js";

/**
 * Protects the approval gate on removing a saved preference.
 *
 * @remarks
 * eve's file memory tools carry no gate of their own. The gate comes from the agent-level
 * `approval` in `agent/agent.ts`, which is easy to drop when that file is edited, so this case
 * fails if a removal ever runs without asking.
 */
export default defineEval({
  description:
    "removing a saved preference parks for approval and is rejected when denied.",
  async test(t) {
    await t.send(
      toolScript("preferences__save_memory", {
        text: "Keep threads under 8 posts.",
      })
    );
    const { session } = await t.send(
      toolScript("preferences__remove_memory", { index: 1 })
    );
    session.requireInteraction({
      optionIds: ["approve", "deny"],
      toolName: "preferences__remove_memory",
    });

    await session.respondAll("deny");
    t.calledTool("preferences__remove_memory", {
      count: 1,
      status: "rejected",
    });
  },
});
