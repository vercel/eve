import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  defineSlackRenderer,
  type SlackInboundMessageContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import { createServiceAuth } from "#lib/auth.ts";
import {
  admitChannelWatchMessage,
  type ChannelWatchMessage,
} from "#lib/channel-watch/admit.ts";
import { getChannelWatchStore } from "#lib/channel-watch/store.ts";
import { SLACK_CONNECTOR } from "#lib/constants.ts";
import { getInvestigationEvidence } from "#lib/evidence.ts";
import { buildInvestigationResultMessage } from "#lib/slack/investigation-rendering.ts";

const slackCredentials = connectSlackCredentials(SLACK_CONNECTOR);

/**
 * Shared mention/DM handler. Eve's defaults for both hooks do exactly two things
 * (post "Thinking..." and derive auth via defaultSlackAuth); eve does not export those
 * default functions, so this restates them.
 */
async function respondToInboundMessage(
  ctx: SlackInboundMessageContext,
  message: SlackMessage
) {
  await ctx.thread.startTyping("Thinking...").catch(console.error);
  return { auth: defaultSlackAuth(message, ctx) };
}

function toChannelWatchMessage(
  message: SlackMessage
): ChannelWatchMessage | null {
  const rawTeamId = message.raw.team;
  const teamId =
    message.teamId ?? (typeof rawTeamId === "string" ? rawTeamId : undefined);
  if (!(teamId && message.channelId && message.ts)) {
    return null;
  }

  const rawSubtype = message.raw.subtype;
  return {
    author: channelWatchAuthor(message.author),
    channelId: message.channelId,
    subtype: typeof rawSubtype === "string" ? rawSubtype : undefined,
    teamId,
    threadTs: message.threadTs,
    ts: message.ts,
    visibleText: message.markdown,
  };
}

function buildChannelWatchContext(): string[] {
  return [
    "You are responding to a message in a channel that you are responsible for watching.",
    "Determine if the current message warrants an investigation. If it does, load the `deep-investigation` skill and follow it. If it clearly needs no investigation, reply with one short sentence saying why.",
  ];
}

/** Authorless bot_message posts have no Slack user; defaultSlackAuth returns null for those. */
function channelWatchServiceAuth(watched: ChannelWatchMessage) {
  return createServiceAuth({
    authenticator: "channel-watch",
    principalId: `${watched.teamId}:${watched.channelId}:${watched.ts}`,
  });
}

function channelWatchAuthor(
  author: SlackMessage["author"]
): ChannelWatchMessage["author"] {
  if (!author) {
    return { kind: "missing" };
  }
  if (author.isMe) {
    return { kind: "self" };
  }
  return { isBot: author.isBot, kind: "other" };
}

const investigationRenderer = defineSlackRenderer({
  events: {
    async "message.completed"(data, channel, _ctx, next) {
      if (data.finishReason === "tool-calls" || !data.message) {
        await next();
        return;
      }

      const evidence = getInvestigationEvidence(data.turnId);
      if (evidence.length === 0) {
        await next();
        return;
      }

      channel.state.pendingToolCallMessage = null;
      try {
        await channel.thread.post(
          buildInvestigationResultMessage(data.message, evidence)
        );
      } catch (error) {
        console.error("[sre/slack] failed to post investigation answer", {
          error: error instanceof Error ? error.message : String(error),
          evidenceCount: evidence.length,
          turnId: data.turnId,
        });
      }
    },
  },
});

export default slackChannel({
  botName: "sre",
  credentials: slackCredentials,

  onAppMention: respondToInboundMessage,

  // Eve selects DMs as onDirectMessage ?? onMessage. Omit this hook and DMs hit the watchlist.
  onDirectMessage: respondToInboundMessage,

  // Channel watch has no eve default to lean on: non-mention channel messages are ignored
  // unless an onMessage hook exists. Admitted messages start an autonomous investigation.
  async onMessage(ctx, message) {
    const watched = toChannelWatchMessage(message);
    if (!watched) {
      return null;
    }

    const admission = await admitChannelWatchMessage(
      watched,
      getChannelWatchStore()
    );
    if (admission.kind === "drop") {
      return null;
    }

    await ctx.thread.startTyping("Thinking...").catch(console.error);
    const auth = message.author
      ? defaultSlackAuth(message, ctx)
      : channelWatchServiceAuth(admission.message);
    if (!auth) {
      return null;
    }
    return {
      auth,
      context: buildChannelWatchContext(),
      title: admission.title,
    };
  },

  renderers: [investigationRenderer],
});
