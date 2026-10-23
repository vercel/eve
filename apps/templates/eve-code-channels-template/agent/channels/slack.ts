import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  defineSlackRenderer,
  loadThreadContextMessages,
  slackChannel,
  type SlackEventContext,
  type SlackInboundMessageContext,
  type SlackMessage,
  type SlackRendererEvents,
} from "eve/channels/slack";

import {
  asksForCodeChannel,
  codeChannelAuth,
  createCodeChannel,
  isAddressedToOthers,
  isCodeChannel,
  isCodeChannelSession,
  isOriginContext,
  setSessionStatus,
  type SlackCall,
  withCodeChannelSessions,
} from "../lib/code-channels";

// `eve add channel/slack` creates or picks a Slack app and writes its
// connector UID here, so keep it a string literal.
export const slackCredentials = connectSlackCredentials("slack/code-channels");

const slackCall =
  (ctx: { slack: { request(operation: string, body: unknown): Promise<unknown> } }): SlackCall =>
  async (operation, body) =>
    (await ctx.slack.request(operation, body)) as Record<string, unknown>;

/** Any human message in a code channel continues the channel's one session. */
function codeChannelTurn(ctx: SlackInboundMessageContext, message: SlackMessage) {
  if (!message.author || message.author.isBot || isOriginContext(message)) return null;
  if (isAddressedToOthers(message.text, ctx.isBotMentioned())) return null;
  const auth = defaultSlackAuth(message, ctx);
  return auth ? { auth: codeChannelAuth(auth, message.channelId) } : null;
}

/**
 * Opens a code channel from a mention that asked for one, then starts the task
 * there with the original thread as context. Falls back to the thread when
 * Slack refuses, for example when Slack Code is not enabled for the workspace.
 */
async function openCodeChannel(ctx: SlackInboundMessageContext, message: SlackMessage) {
  const auth = defaultSlackAuth(message, ctx);
  if (!auth) return null;
  const title = message.text.replace(/<@[A-Z0-9]+>/g, "").trim() || "Coding task";
  const prior = await loadThreadContextMessages(ctx.thread, message).catch(() => []);
  const context = prior.length
    ? [
        "Messages from the thread this code channel was opened from:\n\n" +
          prior.map((m) => `${m.isMe ? "you" : (m.user ?? "user")}: ${m.markdown}`).join("\n"),
      ]
    : [];

  let channelId: string;
  try {
    channelId = await createCodeChannel(slackCall(ctx), {
      title,
      originChannelId: message.channelId,
      originMessageTs: message.ts,
    });
  } catch (error) {
    console.warn("[code-channels] creation failed", error);
    return {
      auth,
      context: [
        ...context,
        "A Slack code channel could not be opened for this request. Work on it in this thread and say so in one short sentence.",
      ],
    };
  }

  await ctx.thread.post(`Working on this in <#${channelId}>.`);
  return { auth: codeChannelAuth(auth, channelId), context, title };
}

async function settle(channel: SlackEventContext) {
  if (!channel.state.channelId) return;
  // Fails once `archive_code_channel` has archived the channel; nothing to settle then.
  await setSessionStatus(slackCall(channel), channel.state.channelId, "active").catch((error) =>
    console.warn("[code-channels] status update failed", error),
  );
}

// eve's default rendering threads status, progress, and task cards under the
// triggering message. A code channel shows its own status and reads top-level,
// so these events render nothing there.
const quietInCodeChannels = Object.fromEntries(
  [
    "action.partial",
    "action.result",
    "actions.requested",
    "message.appended",
    "reasoning.appended",
    "reasoning.completed",
    "step.started",
    "task.started",
    "task.settled",
    "turn.waiting",
    "session.waiting",
    "session.completed",
  ].map((event) => [
    event,
    (_data: unknown, channel: SlackEventContext, _ctx: unknown, next: () => Promise<void>) =>
      isCodeChannelSession(channel.state) ? undefined : next(),
  ]),
) as SlackRendererEvents;

const codeChannelRenderer = defineSlackRenderer({
  async received(message, channel, next) {
    // No "Thinking..." under a code channel message; `turn.started` sets the channel's status.
    if (await isCodeChannel(slackCall(channel), message.channelId).catch(() => false)) return;
    await next();
  },
  events: {
    ...quietInCodeChannels,
    async "turn.started"(data, channel, ctx, next) {
      if (!isCodeChannelSession(channel.state)) return next();
      if (channel.state.channelId) {
        await setSessionStatus(slackCall(channel), channel.state.channelId, "processing").catch(
          (error) => console.warn("[code-channels] status update failed", error),
        );
      }
    },
    async "message.completed"(data, channel, ctx, next) {
      if (!isCodeChannelSession(channel.state)) return next();
      const text = data.message?.trim();
      if (data.finishReason === "tool-calls" || !text) return;
      await channel.slack.request("chat.postMessage", {
        channel: channel.state.channelId,
        markdown_text: text,
        unfurl_links: false,
      });
    },
    async "turn.completed"(data, channel, ctx, next) {
      if (!isCodeChannelSession(channel.state)) return next();
      await settle(channel);
    },
    async "turn.cancelled"(data, channel, ctx, next) {
      if (!isCodeChannelSession(channel.state)) return next();
      await settle(channel);
    },
    async "turn.failed"(data, channel, ctx, next) {
      if (!isCodeChannelSession(channel.state)) return next();
      await channel.slack.request("chat.postMessage", {
        channel: channel.state.channelId,
        markdown_text: "Something went wrong on that turn. Send your message again to retry.",
      });
      await settle(channel);
    },
  },
});

const channel = slackChannel({
  credentials: slackCredentials,
  renderers: [codeChannelRenderer],

  async onAppMention(ctx, message) {
    if (await isCodeChannel(slackCall(ctx), message.channelId)) {
      return codeChannelTurn(ctx, message);
    }
    if (asksForCodeChannel(message.text)) return openCodeChannel(ctx, message);
    return { auth: defaultSlackAuth(message, ctx) };
  },

  async onMessage(ctx, message) {
    // A mention also arrives as `app_mention`, which `onAppMention` handles.
    if (ctx.isBotMentioned()) return null;
    const subtype = message.raw.subtype;
    if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast") return null;
    if (!(await isCodeChannel(slackCall(ctx), message.channelId))) return null;
    return codeChannelTurn(ctx, message);
  },

  onDirectMessage(ctx, message) {
    return { auth: defaultSlackAuth(message, ctx) };
  },
});

export default withCodeChannelSessions(channel);
