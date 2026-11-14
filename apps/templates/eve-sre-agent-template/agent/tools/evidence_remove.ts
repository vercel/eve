import { defineTool } from "eve/tools";
import { z } from "zod";
import { removeInvestigationEvidence } from "#lib/evidence.ts";

export default defineTool({
  description:
    "Remove one recorded evidence item that is erroneous, superseded, redundant, or no longer relevant to the final investigation. Pass the stable ID returned by evidence_record or evidence_list. Do not remove evidence merely because it invalidates a hypothesis.",
  execute({ evidenceId }, ctx) {
    const result = removeInvestigationEvidence(ctx.session.turn.id, evidenceId);
    return {
      evidenceCount: result.count,
      removed: result.removed,
      status: result.removed ? "removed" : "not_found",
    };
  },
  inputSchema: z.object({
    evidenceId: z
      .string()
      .regex(/^evidence-\d+$/u)
      .describe(
        "Stable evidence ID returned by evidence_record or evidence_list."
      ),
  }),
});
