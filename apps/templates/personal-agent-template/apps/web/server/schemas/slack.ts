import { z } from "zod";

export const slackMemberQuerySchema = z.object({
  teamId: z.coerce.string().trim().min(1, "teamId is required"),
  userId: z.coerce.string().trim().min(1, "userId is required"),
});

export const slackLinkConsumeBodySchema = z.object({
  code: z.string().trim().min(1, "code is required"),
  slackTeamId: z.string().trim().min(1, "slackTeamId is required"),
  slackUserId: z.string().trim().min(1, "slackUserId is required"),
  slackUserName: z.string().trim().optional(),
  slackDisplayName: z.string().trim().optional(),
  slackEmail: z.string().trim().email().optional(),
});
