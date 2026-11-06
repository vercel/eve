import { defineTool } from "eve/tools";

import { z } from "#compiled/zod/index.js";

import { readSlackUser } from "../lib/slack-api.js";
import extension from "../extension.js";
import { slackTurn } from "../lib/turn.js";

export default defineTool({
  description:
    "Look up a Slack user's name, title, and time zone by user ID or <@U…> mention, to name people in an answer.",
  inputSchema: z.object({
    userId: z.string().min(1).max(100),
  }),
  label: { start: () => "Looking up a Slack user" },
  async execute({ userId }, ctx) {
    const turn = slackTurn(ctx.session.auth.current, extension.config);
    if (!(await turn.authorize({ tool: "read_user" }))) {
      return {
        unavailable: true,
        reason: "not_authorized",
        message: "This caller may not look up Slack users.",
      } as const;
    }
    return { user: await readSlackUser(turn.request, userId) };
  },
});
