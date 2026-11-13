import { z } from "zod";

const autofillSurfaceKindSchema = z.string().trim().min(1).max(80);

const detectedAutofillFieldSchema = z.object({
  score: z.number().min(0).max(100),
  token: z.string().trim().min(1).max(80),
});

const detectedAutofillSurfaceSchema = z.object({
  fields: z.array(detectedAutofillFieldSchema).min(1).max(40),
  id: z.string().trim().min(1).max(120),
  kind: autofillSurfaceKindSchema,
});

const autofillSuggestionSchema = z.object({
  candidateId: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(120),
  matchReason: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(200),
});

const autofillClaimSchema = z.object({
  id: z.uuid(),
  token: z.string().trim().min(1).max(80),
  value: z.string().min(1).max(20_000),
});

export type AutofillClaim = z.infer<typeof autofillClaimSchema>;
export type AutofillSuggestion = z.infer<typeof autofillSuggestionSchema>;
export type DetectedAutofillSurface = z.infer<
  typeof detectedAutofillSurfaceSchema
>;
