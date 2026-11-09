import type { SessionAuthContext } from "#channel/types.js";
import type { RequestSettlement } from "#channel/interaction-prompts.js";
import { postedIn, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
import type { Interaction } from "#channel/interaction-prompts.js";

import { createLogger } from "#internal/logging.js";
import {
  renderTelegramAuthorizationPrompt,
  renderTelegramAuthorizationStatus,
} from "#public/channels/telegram/authorization.js";
import {
  registerTelegramFreeformPrompt,
  registerTelegramHitlPrompt,
  renderTelegramInteraction,
  takeTelegramResolvedPrompt,
} from "#public/channels/telegram/hitl.js";
import type { TelegramMessage } from "#public/channels/telegram/inbound.js";
import type {
  TelegramChannelEvents,
  TelegramContext,
  TelegramInboundResult,
} from "#public/channels/telegram/telegramChannel.js";

const log = createLogger("telegram.defaults");

type TelegramEventChannel = Parameters<
  NonNullable<TelegramChannelEvents["interaction.opened"]>
>[1]["channel"];

/**
 * A Telegram chat as a sign-in shows on it: a private chat gets the sign-in button; a group, a
 * status whose Authorize button sends the requester the prompt privately.
 */
function telegramSignIns(channel: TelegramEventChannel): SignInSurface {
  const { telegram } = channel;
  const posting = async (message: Parameters<typeof telegram.post>[0]) => {
    try {
      return (await telegram.post(message)).id || undefined;
    } catch (error) {
      log.error("Telegram sign-in message delivery failed", { error });
      return undefined;
    }
  };
  return {
    private: telegram.chatType === "private",
    postChallenge: (signIn) => posting(renderTelegramAuthorizationPrompt(signIn)),
    post: posting,
    postStatus: (signIn) =>
      posting(
        renderTelegramAuthorizationStatus({
          displayName: signIn.displayName,
          requesterUserId: channel.state.triggeringUserId,
        }),
      ),
    async edit(messageId, text) {
      try {
        await telegram.editMessageText({ messageId, replyMarkup: { inline_keyboard: [] }, text });
      } catch (error) {
        log.error("Telegram sign-in status edit failed", { error });
      }
    },
    typing: () => telegram.startTyping(),
    posted: postedIn(channel.state, "pendingAuthMessageIds"),
  };
}

/**
 * Default auth projection for Telegram webhook actors. A button press passes
 * the message it was on with the presser as `from`.
 */
export function defaultTelegramAuth(
  message: Pick<TelegramMessage, "chat" | "from" | "messageId" | "messageThreadId">,
): SessionAuthContext | null {
  const user = message.from;
  if (!user) return null;

  const attributes: Record<string, string> = {
    chat_id: message.chat.id,
    chat_type: message.chat.type,
    message_id: message.messageId,
    user_id: user.id,
  };
  if (message.chat.title !== undefined) attributes.chat_title = message.chat.title;
  if (message.messageThreadId !== undefined) {
    attributes.message_thread_id = String(message.messageThreadId);
  }
  if (user.username !== undefined) attributes.username = user.username;

  const groupScoped = message.chat.type === "group" || message.chat.type === "supergroup";
  const principalId = groupScoped
    ? `telegram:${message.chat.id}:${user.id}`
    : `telegram:${user.id}`;

  return {
    attributes,
    authenticator: "telegram-webhook",
    issuer: groupScoped ? `telegram:${message.chat.id}` : "telegram",
    principalId,
    principalType: user.isBot ? "service" : "user",
  };
}

/** Default inbound message hook: dispatch allowed messages with Telegram user auth. */
export async function defaultOnMessage(
  ctx: TelegramContext,
  message: TelegramMessage,
): Promise<TelegramInboundResult> {
  if (!shouldDispatchTelegramMessage(message, ctx.telegram.botUsername)) return null;
  await ctx.telegram.startTyping();
  return { auth: defaultTelegramAuth(message) };
}

export function isTelegramBotMentioned(
  message: Pick<TelegramMessage, "caption" | "text">,
  botUsername: string | undefined,
): boolean {
  if (botUsername === undefined) return false;
  const text = message.text || message.caption;
  if (isTargetedBotCommand(text, botUsername)) return true;
  const escapedUsername = botUsername.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_])@${escapedUsername}(?=$|[^A-Za-z0-9_])`, "iu").test(text);
}

async function postTelegramRequest(
  channel: TelegramEventChannel,
  request: Interaction,
): Promise<void> {
  const rendered = renderTelegramInteraction(request, channel.state);
  const posted = await channel.telegram.post({
    reply_markup: rendered.replyMarkup,
    text: rendered.text,
  });
  if (!posted.id) return;
  if (rendered.freeformRequestId !== undefined) {
    registerTelegramFreeformPrompt(channel.state, {
      messageId: posted.id,
      requestId: rendered.freeformRequestId,
    });
  } else {
    registerTelegramHitlPrompt(channel.state, request, {
      messageId: posted.id,
      text: rendered.text,
    });
  }
}

async function editTelegramResolvedPrompt(
  channel: TelegramEventChannel,
  resolution: RequestSettlement,
): Promise<void> {
  const edit = takeTelegramResolvedPrompt(channel.state, resolution);
  if (edit === undefined) return;
  try {
    await channel.telegram.editMessageText({
      ...edit,
      replyMarkup: { inline_keyboard: [] },
    });
  } catch (error) {
    log.warn("Telegram answered prompt edit failed", {
      error,
      requestId: resolution.interactionId,
    });
  }
}

/** Built-in Telegram event handlers for typing, replies, HITL, and terminal errors. */
export const defaultEvents: TelegramChannelEvents = surfaceEvents<TelegramEventChannel>({
  typing: (channel) => channel.telegram.startTyping(),
  post: (channel, text) => channel.telegram.post(text),
  restart: "message",
  requests: { show: postTelegramRequest, settle: editTelegramResolvedPrompt },
  signIns: telegramSignIns,
});

function shouldDispatchTelegramMessage(
  message: TelegramMessage,
  botUsername: string | undefined,
): boolean {
  if (message.from?.isBot === true) return false;
  if (message.chat.type === "channel") return false;

  const text = message.text || message.caption;
  const hasContent = text.trim().length > 0 || message.attachments.length > 0;
  if (!hasContent) return false;

  if (message.chat.type === "private") return true;
  if (message.replyToMessage?.from?.isBot === true) return true;

  if (isBotCommand(text, botUsername)) return true;
  if (botUsername !== undefined && mentionsBotUsername(text, botUsername)) return true;

  return false;
}

function isBotCommand(text: string, botUsername: string | undefined): boolean {
  const match = /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u.exec(text);
  if (!match) return false;
  const target = match.groups?.target;
  if (target === undefined) return true;
  return botUsername !== undefined && target.toLowerCase() === botUsername.toLowerCase();
}

function isTargetedBotCommand(text: string, botUsername: string): boolean {
  const match = /^\/[A-Za-z0-9_]+@(?<target>[A-Za-z0-9_]+)(?:\s|$)/u.exec(text);
  return match?.groups?.target?.toLowerCase() === botUsername.toLowerCase();
}

function mentionsBotUsername(text: string, botUsername: string): boolean {
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}
