import { defineTool } from "eve/tools";
import { z } from "zod";
import { getInvestigationEvidence } from "#lib/evidence.ts";

export default defineTool({
  description:
    "List the evidence currently recorded for this investigation turn, including the stable IDs accepted by evidence_remove. Use this when reviewing the evidence set or when you need an ID for removal.",
  execute(_input, ctx) {
    const items = getInvestigationEvidence(ctx.session.turn.id);
    return {
      evidenceCount: items.length,
      items,
    };
  },
  inputSchema: z.object({}),
});
