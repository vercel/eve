import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension.ts";
import { REACT_WITH_EMOJI_DESCRIPTION } from "../lib/descriptions.ts";
import {
  addEmojiReactions,
  reactWithEmojiInputSchema,
  resolveReactionTarget,
} from "../lib/reactions.ts";
import { defaultReactionScope } from "../lib/scope.ts";
import { reactionClient } from "../lib/slack-client.ts";

// Offered only on sessions with a reaction scope; the resolver captures the
// Slack coordinates from the session's channel metadata.
export default defineDynamic((ctx) => {
  const config = extension.config;
  const scope = (config.scope ?? defaultReactionScope)(ctx.channel);
  if (!scope) return null;

  return defineTool({
    description: REACT_WITH_EMOJI_DESCRIPTION,
    inputSchema: reactWithEmojiInputSchema,
    async execute({ reactions, message_ts, message_url }) {
      const target = resolveReactionTarget({
        channelId: scope.channelId,
        defaultTs: scope.messageTs,
        messageTs: message_ts,
        messageUrl: message_url,
      });
      if (!target.ok) return { success: false, error: target.error };
      try {
        const result = await addEmojiReactions(
          reactionClient(ctx.channel, config),
          scope.channelId,
          target.ts,
          reactions,
          config.searchEmoji,
        );
        if (result.reacted.length === 0) {
          return {
            success: false,
            error: "Could not add any reactions. Continue with the substantive reply if needed.",
          };
        }
        return {
          success: true,
          ...result,
          nextStep: "Post the substantive reply if one is needed. Otherwise end the turn.",
        };
      } catch (error) {
        console.error("Failed to add Slack emoji reactions", error);
        return {
          success: false,
          error: "Could not add the reactions. Continue with the substantive reply if needed.",
        };
      }
    },
  });
});
