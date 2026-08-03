import { defineTool } from "eve/tools";

import { PROPOSAL_REFERENCE_SCHEMA, PROPOSE_EDITS_INPUT_SCHEMA } from "../lib/edit-contracts.js";
import { proposeEdits } from "../lib/edits.js";

export default defineTool({
  description:
    "Validate and record one complete set of eve source edits without writing files. Pass the returned proposalId to selfmod__finalize_edits.",
  inputSchema: PROPOSE_EDITS_INPUT_SCHEMA,
  outputSchema: PROPOSAL_REFERENCE_SCHEMA,
  async execute(input, ctx) {
    return await proposeEdits(await ctx.getSandbox(), input);
  },
});
