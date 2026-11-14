import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const investigationWebhookSchema = z.object({
  description: nonEmptyString.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  slackChannel: nonEmptyString,
  title: nonEmptyString,
});

export type InvestigationWebhook = z.infer<typeof investigationWebhookSchema>;

export function parseInvestigationWebhook(raw: unknown) {
  return investigationWebhookSchema.safeParse(raw);
}
