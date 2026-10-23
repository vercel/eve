import { defineTool } from "eve/tools";
import { z } from "zod";

import { codeChannelApi } from "../lib/code-channels";
import { codeChannelTarget, NOT_IN_CODE_CHANNEL } from "../lib/slack";

export default defineTool({
  description:
    "Replace the links in the code channel's context bar, such as the repository, branch, pull request, or preview deployment. Include every link that should stay.",
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          key: z.string().describe("Stable id, such as repo, branch, pr, or preview"),
          label: z.string().max(128),
          url: z.url({ protocol: /^https$/ }),
          icon: z.string().optional().describe("Slack icon name, such as folder or hierarchy"),
        }),
      )
      .max(5),
  }),
  async execute({ items }, ctx) {
    const target = codeChannelTarget(ctx.session.auth.current);
    if (!target) return NOT_IN_CODE_CHANNEL;
    await codeChannelApi(target.call, "agents.conversations.setProperties", {
      channel_id: target.channelId,
      code_channel: { context_bar_items: items },
    });
    return { ok: true };
  },
});
