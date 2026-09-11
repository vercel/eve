import { z } from "zod";

const agreementScoreSchema = z.number().int().min(0).max(100);

export const councilResultSchema = z.object({
  summary: z.string(),
  agreementScores: z.object({
    claude: agreementScoreSchema,
    grok: agreementScoreSchema,
    kimi: agreementScoreSchema,
    openai: agreementScoreSchema,
  }),
});

export type CouncilResult = z.infer<typeof councilResultSchema>;
export type MemberId = keyof CouncilResult["agreementScores"];
