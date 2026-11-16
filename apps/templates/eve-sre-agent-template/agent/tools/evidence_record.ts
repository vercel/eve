import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  INVESTIGATION_EVIDENCE_SOURCE_TYPES,
  isHttpUrl,
  recordInvestigationEvidence,
} from "#lib/evidence.ts";

export default defineTool({
  description:
    "Record one novel, decision-relevant investigation finding immediately after you discover it; returns the stable evidence ID used by evidence_remove. Follow the Evidence rules in the agent instructions.",

  execute(input, ctx) {
    const result = recordInvestigationEvidence(ctx.session.turn.id, input);
    return {
      evidenceCount: result.count,
      evidenceId: result.evidenceId,
      status: result.recorded ? "recorded" : "duplicate",
    };
  },
  inputSchema: z.object({
    finding: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Concise, novel observation supported by the linked source."),
    sourceLabel: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Short human-readable label for the source link."),
    sourceType: z.enum(INVESTIGATION_EVIDENCE_SOURCE_TYPES),
    sourceUrl: z
      .string()
      .trim()
      .max(8192)
      .refine(isHttpUrl, "sourceUrl must be an HTTP(S) URL")
      .describe("Canonical HTTP(S) permalink or deep link for this evidence."),
  }),
});
