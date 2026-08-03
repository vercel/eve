import { defineTool } from "eve/tools";

import { FINALIZE_EDITS_OUTPUT_SCHEMA, PROPOSAL_REFERENCE_SCHEMA } from "../lib/edit-contracts.js";
import { finalizeEdits, requireProposalApproval } from "../lib/edits.js";

export default defineTool({
  approval: requireProposalApproval,
  description:
    "Request human approval for a proposal returned by selfmod__propose_edits, then apply only its recorded source changes.",
  inputSchema: PROPOSAL_REFERENCE_SCHEMA,
  outputSchema: FINALIZE_EDITS_OUTPUT_SCHEMA,
  async execute({ proposalId }, ctx) {
    return await finalizeEdits(await ctx.getSandbox(), proposalId);
  },
});
