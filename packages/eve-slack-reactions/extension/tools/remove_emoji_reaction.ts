import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension.ts";
import { REMOVE_EMOJI_REACTION_DESCRIPTION } from "../lib/descriptions.ts";
import {
  removeEmojiReaction,
  removeEmojiReactionInputSchema,
  resolveReactionTarget,
} from "../lib/reactions.ts";
import { defaultReactionScope } from "../lib/scope.ts";
import { reactionClient } from "../lib/slack-client.ts";

// Same scope and targeting as react_with_emoji.
export default defineDynamic((ctx) => {
  const config = extension.config;
  const scope = (config.scope ?? defaultReactionScope)(ctx.channel);
  if (!scope) return null;

  return defineTool({
    description: REMOVE_EMOJI_REACTION_DESCRIPTION,
    inputSchema: removeEmojiReactionInputSchema,
    async execute({ name, message_ts, message_url }) {
      const target = resolveReactionTarget({
        channelId: scope.channelId,
        defaultTs: scope.messageTs,
        messageTs: message_ts,
        messageUrl: message_url,
      });
      if (!target.ok) return { success: false, error: target.error };
      try {
        const removed = await removeEmojiReaction(
          reactionClient(ctx.channel, config),
          scope.channelId,
          target.ts,
          name,
        );
        return { success: true, removed, name };
      } catch (error) {
        console.error("Failed to remove Slack emoji reaction", error);
        return { success: false, error: "Could not remove the reaction." };
      }
    },
  });
});
