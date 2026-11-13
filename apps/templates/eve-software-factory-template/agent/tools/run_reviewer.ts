import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { REVIEWER_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `reviewer` station.
 *
 * @remarks
 * - `defineAgent` has no `outputSchema` anymore; `ctx.agent()` takes one per call.
 * - Named `run_reviewer`, not `reviewer`: the compiler rejects a tool and a local subagent with the same public name.
 */
export default defineWorkflowTool({
  description:
    "Independently review a pushed factory branch against the original work item and its " +
    "acceptance criteria: fetch the branch, read the real diff, re-run cheap checks, and " +
    "return approve, request_changes, or reject with specific findings. Never modifies " +
    "code. The caller passes the work item, the analysis with acceptance criteria, the " +
    "branch name, and the implementer's report in the message, plus an artifact id when " +
    "the analyst saved its full detail as one.",
  async execute({ message }, ctx) {
    "use workflow";
    return await ctx.agent("reviewer", {
      message,
      outputSchema: REVIEWER_OUTPUT_SCHEMA,
    });
  },
  inputSchema: z.object({
    message: z
      .string()
      .describe(
        "Everything the station needs; it does not see your conversation history."
      ),
  }),
});
