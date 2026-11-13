import { isChannel } from "eve/channels";
import type { ToolContext } from "eve/tools";

import recall from "../channels/recall.js";

/** The Recall bot serving this session, or `undefined` outside a meeting. */
export function meetingBotId(ctx: Pick<ToolContext, "channel">): string | undefined {
  if (!isChannel(ctx.channel, recall)) return undefined;
  const { botId } = ctx.channel.metadata;
  return typeof botId === "string" ? botId : undefined;
}
