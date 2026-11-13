import {
  type SlackContext,
  type SlackEvent,
  type SlackInboundEventContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import {
  firstHumanMention,
  isTrustedOnBehalfOfPoster,
  ON_BEHALF_OF_BOTS,
  slackCredentials,
  slackSessionAuth,
} from "#lib/slack/config.js";

/**
 * This bot's own Slack user id, cached for the life of a warm instance.
 *
 * @remarks
 * `undefined` means not yet fetched. A failed lookup is not cached, so the next message retries.
 */
let cachedBotUserId: string | undefined;

/**
 * Resolve this bot's own Slack user id with `auth.test`.
 *
 * @param ctx - The Slack handler context.
 * @returns The bot's user id, or `undefined` when the lookup fails.
 */
const resolveBotUserId = async (
  ctx: SlackContext
): Promise<string | undefined> => {
  if (cachedBotUserId) {
    return cachedBotUserId;
  }
  try {
    const res = (await ctx.slack.request("auth.test", {})) as {
      ok?: boolean;
      user_id?: string;
    };
    if (res.ok && res.user_id) {
      cachedBotUserId = res.user_id;
    }
  } catch (error) {
    console.warn(
      "auth.test threw",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
  return cachedBotUserId;
};

/**
 * Work out which person a bot post acts for, if any.
 *
 * @remarks
 * A Slack Workflow that tags the agent has no human author, so the session is attributed to the
 * first person its text mentions besides the bot. The workflow template therefore has to mention
 * the submitter alongside the agent.
 *
 * This only applies to bots on the `SLACK_ON_BEHALF_OF_BOTS` allow list. Any other bot post is
 * never attributed to a person, because anything that can post a mention would otherwise start a
 * session with that person's access. When the bot's own id can't be resolved, its mention can't be
 * told apart from a person's, so nothing is attributed.
 *
 * @param ctx - The Slack handler context.
 * @param message - The inbound message.
 * @returns The mentioned person's user id, or `undefined` when the post is not attributed.
 */
const resolveOnBehalfOfUserId = async (
  ctx: SlackContext,
  message: SlackMessage
): Promise<string | undefined> => {
  if (!isTrustedOnBehalfOfPoster(message, ON_BEHALF_OF_BOTS)) {
    return;
  }
  const botUserId = await resolveBotUserId(ctx);
  if (!botUserId) {
    return;
  }
  return firstHumanMention(message.text, botUserId);
};

/**
 * Dispatch a message with the auth {@link slackSessionAuth} derives.
 *
 * @remarks
 * A message with no identifiable sender is dispatched with `auth: null`, so the session carries no
 * identity and user-scoped tools decline.
 *
 * There is no typing indicator to set here: eve shows `Thinking...` itself, before a mention or
 * DM handler runs and after `onMessage` accepts a message, and clears it when a handler drops one.
 *
 * @param ctx - The Slack handler context.
 * @param message - The inbound message.
 * @returns The dispatch result carrying the session auth.
 */
const handleInbound = async (ctx: SlackContext, message: SlackMessage) => ({
  auth: slackSessionAuth(message, await resolveOnBehalfOfUserId(ctx, message)),
});

/**
 * Whether the message's author is the only person who has ever posted in this thread.
 *
 * @remarks
 * Keeps auto-replies in a subscribed thread scoped to the original requester: once anyone else
 * joins, replies without a mention stop dispatching, and an explicit mention is the way back in.
 *
 * `listParticipants` returns the thread's unique human user ids in first-appearance order, with
 * bot and system messages already excluded, so a single entry matching the author is the whole
 * test.
 *
 * Two limits resolve toward replying. It observes at most the first 50 messages of a thread, so a
 * second person who only appears after that is not seen. And a failed refresh keeps the last
 * successful snapshot, so the list can be stale. A thread whose refresh has never succeeded
 * returns an empty list, which fails closed here.
 *
 * @param ctx - The Slack handler context.
 * @param message - The inbound message.
 * @returns `true` when the author is the thread's sole human participant.
 */
const isSoleThreadParticipant = async (
  ctx: SlackContext,
  message: SlackMessage
): Promise<boolean> => {
  const authorId = message.author?.userId;
  if (!authorId) {
    return false;
  }
  const participants = await ctx.thread.listParticipants();
  return participants.length === 1 && participants[0] === authorId;
};

/** One prompt offered at the top of a freshly opened conversation. */
interface SuggestedPrompt {
  /** Full text sent as the user's message the moment the prompt is clicked. */
  message: string;
  /** Short label rendered on the prompt button. */
  title: string;
}

/** Heading shown above {@link SUGGESTED_PROMPTS}. */
const SUGGESTED_PROMPTS_TITLE = "What the team can do";

/**
 * Prompts pinned when someone opens a fresh conversation with the team.
 *
 * @remarks
 * Slack renders at most four, so this is one prompt per specialist rather than a tour of the whole
 * team: positioning, long-form, social, and organic search. The email specialist is the omission,
 * because it reshapes copy that already exists rather than originating a piece, which makes it a
 * poor opening ask. It stays reachable by asking for it.
 *
 * Each message names the deliverable, asks for the shared context, and then hands the interview
 * back. Loading the brand context is already the lead's own habit, so saying it here is for the
 * person reading: it shows a new user that the team works from a shared picture of the
 * product before it writes anything.
 *
 * Every message has to be a complete sentence. Slack sends the text verbatim on click with no
 * chance to edit, so one that trailed off mid-phrase would arrive truncated.
 */
const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    message:
      "Help me sharpen our positioning: what the product is, who it's for, and why anyone would " +
      "pick it. Pull the brand context, then interview me about anything you're missing.",
    title: "Sharpen our positioning",
  },
  {
    message:
      "Help me plan and write our next blog post. Pull the brand context, then ask me for " +
      "details about the post.",
    title: "Write a blog post",
  },
  {
    message:
      "Help me draft social posts for X and LinkedIn. Pull the brand context, then ask me what " +
      "we're promoting.",
    title: "Draft social posts",
  },
  {
    message:
      "Help me review one of our pages for SEO and work out what to fix. Pull the brand context, " +
      "then ask me for the URL.",
    title: "Review a page's SEO",
  },
];

/** Slack coordinates a suggested-prompts call targets. */
interface SuggestedPromptsTarget {
  channelId: string;
  threadTs?: string;
}

/**
 * Where a newly opened conversation's prompts belong, or `undefined` when this event isn't a
 * conversation opening.
 *
 * @remarks
 * Slack signals the same moment two ways, and which one arrives depends on the app's manifest mode.
 * The classic assistant container creates the thread first and fires `assistant_thread_started`
 * carrying its coordinates. The newer Agent messaging experience has no thread yet and pins prompts
 * to the top of the Messages tab, firing `app_home_opened` instead; `thread_ts` is optional on the
 * API, so that case omits it. The Home tab fires the same event and is not a conversation, so it is
 * ignored.
 *
 * @param event - The inbound Slack event.
 * @returns The channel and optional thread to pin prompts to, or `undefined`.
 */
function suggestedPromptsTarget(
  event: SlackEvent
): SuggestedPromptsTarget | undefined {
  if (event.type === "assistant_thread_started") {
    const thread = event.assistant_thread as
      | { channel_id?: unknown; thread_ts?: unknown }
      | undefined;
    const channelId = thread?.channel_id;
    if (typeof channelId !== "string" || channelId.length === 0) {
      return;
    }
    const threadTs = thread?.thread_ts;
    const target: SuggestedPromptsTarget = { channelId };
    if (typeof threadTs === "string" && threadTs.length > 0) {
      target.threadTs = threadTs;
    }
    return target;
  }
  if (event.type === "app_home_opened" && event.tab === "messages") {
    const channelId = event.channel;
    return typeof channelId === "string" && channelId.length > 0
      ? { channelId }
      : undefined;
  }
}

/**
 * Pins {@link SUGGESTED_PROMPTS} when a conversation opens.
 *
 * @remarks
 * Prompts are a nicety, so a failure here is reported and dropped rather than allowed to affect
 * delivery. The likeliest one is a Slack app missing the `assistant:write` scope or the Agents and
 * AI Apps feature, which returns `missing_scope` or stops the event arriving at all, so the reason
 * is worth surfacing rather than swallowing. Only the error's message is logged.
 *
 * @param ctx - The Slack event context.
 * @param event - The inbound Slack event.
 * @returns Nothing; resolves once the prompts are set or the failure is logged.
 */
async function setSuggestedPrompts(
  ctx: SlackInboundEventContext,
  event: SlackEvent
): Promise<void> {
  const target = suggestedPromptsTarget(event);
  if (!target) {
    return;
  }
  try {
    const body: Record<string, unknown> = {
      channel_id: target.channelId,
      prompts: SUGGESTED_PROMPTS,
      title: SUGGESTED_PROMPTS_TITLE,
    };
    if (target.threadTs) {
      body.thread_ts = target.threadTs;
    }
    const response = await ctx.slack.request(
      "assistant.threads.setSuggestedPrompts",
      body
    );
    if (response.ok !== true) {
      console.warn("assistant.threads.setSuggestedPrompts returned not-ok", {
        channelId: target.channelId,
        error: response.error,
      });
    }
  } catch (error) {
    console.warn("assistant.threads.setSuggestedPrompts threw", {
      channelId: target.channelId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Slack channel: answers @mentions and DMs, replies in threads, renders approvals as buttons, and
 * offers suggested prompts when a conversation opens.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect through the shared {@link slackCredentials}, which
 * supplies both the outbound bot token and inbound webhook verification, so there are no Slack
 * secrets to manage in code. Session identity comes from `lib/slack/config.ts`. Create the
 * connector with `vercel connect create slack --name <name> --triggers`, then register this
 * project's trigger destination at `/eve/v1/slack`.
 *
 * {@link setSuggestedPrompts} needs three things set on that connector before it can do anything:
 * the Agents and AI Apps feature enabled, `assistant:write` under Bot Scopes, and
 * `assistant_thread_started` plus `app_home_opened` under Trigger Event Types. Without them the
 * event never arrives and the rest of the channel is unaffected.
 *
 * @defaultValue The connector UID falls back to `"slack/marketing-team"` when `SLACK_CONNECTOR` is
 * unset.
 */
export default slackChannel({
  credentials: slackCredentials,
  onAppMention: handleInbound,
  onDirectMessage: handleInbound,
  /**
   * Everything the handlers above don't claim. Mentions and DMs are parsed out before this runs, so
   * the only event acted on here is a conversation opening, which pins the suggested prompts.
   */
  onEvent: setSuggestedPrompts,
  /**
   * Channel messages with no mention. Mentions and DMs never reach here, because the handlers
   * above take precedence. Auto-reply only in a thread with an active session, and only while the
   * original requester is its sole human participant.
   *
   * @param ctx - The Slack handler context.
   * @param message - The inbound message.
   * @returns The dispatch result, or `null` to ignore the message.
   */
  async onMessage(ctx, message) {
    if (message.author?.isBot) {
      return null;
    }
    if (!(await ctx.isSubscribed())) {
      return null;
    }
    if (!(await isSoleThreadParticipant(ctx, message))) {
      return null;
    }
    return handleInbound(ctx, message);
  },
  threadContext: { since: "thread-root" },
});
