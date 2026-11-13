import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { ANALYST_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `analyst` station.
 *
 * @remarks
 * - `defineAgent` has no `outputSchema` anymore; `ctx.agent()` takes one per call.
 * - Named `run_analyst`, not `analyst`: the compiler rejects a tool and a local subagent with the same public name.
 */
export default defineWorkflowTool({
  description:
    "Analyze a classified work item against the real repository checkout and produce an " +
    "implementation plan: problem statement, approach, ordered steps, affected files, " +
    "risks, acceptance criteria, and test strategy. Planning only; writes no code. The " +
    "caller passes the work item, its classification, and any research findings in the " +
    "message, plus a research artifact id when the researcher saved a full memo. May " +
    "save its own deep supporting detail as an analysis artifact and return the id.",
  async execute({ message }, ctx) {
    "use workflow";
    return await ctx.agent("analyst", {
      message,
      outputSchema: ANALYST_OUTPUT_SCHEMA,
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
