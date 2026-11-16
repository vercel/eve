import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { implementationMessage } from "../lib/stations/implementation-message.js";
import { stationOutput } from "../lib/stations/result.js";
import { IMPLEMENTER_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `implementer` station.
 *
 * @remarks
 * - `defineAgent` has no `outputSchema` anymore; `ctx.agent()` takes one per call.
 * - Named `run_implementer`, not `implementer`: the compiler rejects a tool and a local subagent with the same public name.
 */
export default defineWorkflowTool({
  description:
    "Execute an approved implementation plan in a checkout of the factory repository: " +
    "write the code on a feature branch, run the repository's own checks, commit, and " +
    "push the branch. Returns the branch name, per-file change summary, verification " +
    "results, and deviations. The caller passes the work item, classification, and full " +
    "analysis in the message, plus an artifact id when the analyst saved its full detail " +
    "as one; on a revision run it also passes the existing branch and the reviewer's " +
    "findings.",
  async execute({ message }, ctx) {
    "use workflow";
    const input = await implementationMessage(message, ctx);
    const response = await ctx.agent("implementer").send(input, {
      outputSchema: IMPLEMENTER_OUTPUT_SCHEMA,
      signal: ctx.abortSignal,
    });
    return stationOutput("implementer", await response.result());
  },
  inputSchema: z.object({
    message: z
      .string()
      .describe(
        "Everything the station needs; it does not see your conversation history."
      ),
  }),
});
