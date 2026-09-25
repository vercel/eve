import { z } from "#compiled/zod/index.js";

/** Only the routing fields needed by an action; never a copy of channel state. */
export const slackActionContextSchema = z
  .object({
    installationTeamId: z.string().regex(/^T[A-Z0-9]+$/u),
    teamId: z.string().regex(/^T[A-Z0-9]+$/u),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/u),
    channelId: z.string().regex(/^[CDG][A-Z0-9]+$/u),
    threadTs: z.string().regex(/^\d{10,16}\.\d{6}$/u),
  })
  .strict();

export type SlackActionContext = z.infer<typeof slackActionContextSchema>;
