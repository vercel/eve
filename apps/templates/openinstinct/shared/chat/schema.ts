import { z } from "zod";

const chatUsageSchema = z.object({
  costUsd: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const chatSummarySchema = z.object({
  channel: z.string().min(1).nullable(),
  createdAt: z.string(),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string(),
  usage: chatUsageSchema,
});

export const chatListSchema = z.array(chatSummarySchema);

export const saveChatSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(240).optional(),
  usage: chatUsageSchema.optional(),
});

export type ChatUsage = z.infer<typeof chatUsageSchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type SaveChat = z.infer<typeof saveChatSchema>;
