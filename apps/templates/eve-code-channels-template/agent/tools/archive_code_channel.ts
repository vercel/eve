import { defineTool } from "eve/tools";
import { z } from "zod";

import { codeChannelApi } from "../lib/code-channels";
import { codeChannelTarget, NOT_IN_CODE_CHANNEL } from "../lib/slack";

export default defineTool({
  description:
    "Post a final summary and archive the code channel. Only call it when the requester confirms the task is done. The summary is the closing message, so do not repeat it afterwards.",
  inputSchema: z.object({
    summary: z.string().describe("What was done, with links to pull requests or deployments"),
  }),
  async execute({ summary }, ctx) {
    const target = codeChannelTarget(ctx.session.auth.current);
    if (!target) return NOT_IN_CODE_CHANNEL;
    const posted = await target.call("chat.postMessage", {
      channel: target.channelId,
      markdown_text: summary,
    });
    if (posted.ok !== true || typeof posted.ts !== "string") {
      throw new Error(`Slack chat.postMessage failed: ${String(posted.error)}`);
    }
    await codeChannelApi(target.call, "agents.conversations.archive", {
      channel_id: target.channelId,
      summary_message_ts: posted.ts,
    });
    return { ok: true, archived: true };
  },
});
