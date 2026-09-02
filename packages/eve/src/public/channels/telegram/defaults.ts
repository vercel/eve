import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import {
  extractScheduledRecoveryNotice,
  formatScheduledRecoveryNotice,
} from "#public/channels/scheduled-recovery.js";
import {
  formatTelegramAuthorizationDisplayName,
  renderTelegramAuthorizationCompleted,
  renderTelegramAuthorizationPrompt,
  renderTelegramAuthorizationStatus,
} from "#public/channels/telegram/authorization.js";
import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
} from "#public/channels/telegram/hitl.js";
import type { TelegramMessage } from "#public/channels/telegram/inbound.js";
import type {
  TelegramChannelEvents,
  TelegramContext,
  TelegramInboundResult,
} from "#public/channels/telegram/telegramChannel.js";

const log = createLogger("telegram.defaults");

/** Default auth projection for Telegram webhook actors. */
export function defaultTelegramAuth(message: TelegramMessage): SessionAuthContext | null {
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

/** Built-in Telegram event handlers for typing, replies, HITL, and terminal errors. */
export const defaultEvents: TelegramChannelEvents = {
  async "turn.started"(_event, channel, _ctx) {
    await channel.telegram.startTyping();
  },

  async "authorization.required"(event, channel, _ctx) {
    if (event.candidateId !== undefined) return;

    const displayName = formatTelegramAuthorizationDisplayName(
      event.name,
      event.authorization?.displayName,
    );
    const isPrivate = channel.telegram.chatType === "private";
    const pending = channel.state.pendingAuthMessageIds ?? {};

    if (isPrivate) {
      try {
        const posted = await channel.telegram.post(renderTelegramAuthorizationPrompt(event));
        if (posted.id) {
          channel.state.pendingAuthMessageIds = { ...pending, [event.name]: posted.id };
        }
      } catch (error) {
        log.error("Telegram authorization prompt delivery failed", { error, name: event.name });
      }
      return;
    }

    if (pending[event.name] === undefined) {
      try {
        const posted = await channel.telegram.post(
          renderTelegramAuthorizationStatus({
            displayName,
            requesterUserId: channel.state.triggeringUserId,
          }),
        );
        if (posted.id) {
          channel.state.pendingAuthMessageIds = { ...pending, [event.name]: posted.id };
        }
      } catch (error) {
        log.error("Telegram authorization status delivery failed", { error, name: event.name });
      }
    }
  },

  async "authorization.completed"(event, channel, _ctx) {
    if (event.outcome === "authorized" && event.candidateId === undefined) {
      await channel.telegram.startTyping();
    }
    if (event.candidateId !== undefined) return;

    const pending = channel.state.pendingAuthMessageIds ?? {};
    const messageId = pending[event.name];
    if (messageId === undefined) return;
    const displayName = formatTelegramAuthorizationDisplayName(
      event.name,
      event.authorization?.displayName,
    );
    try {
      await channel.telegram.editMessageText({
        messageId,
        replyMarkup: { inline_keyboard: [] },
        text: renderTelegramAuthorizationCompleted({
          displayName,
          outcome: event.outcome,
          reason: event.reason,
        }),
      });
    } catch (error) {
      log.error("Telegram authorization status edit failed", { error, name: event.name });
    }
    const next = { ...pending };
    delete next[event.name];
    channel.state.pendingAuthMessageIds = next;
  },

  async "actions.requested"(_event, channel, _ctx) {
    await channel.telegram.startTyping();
  },

  async "input.requested"(event, channel, _ctx) {
    for (const request of event.requests) {
      const rendered = renderTelegramInputRequest(request, channel.state);
      const posted = await channel.telegram.post({
        reply_markup: rendered.replyMarkup,
        text: rendered.text,
      });
      if (rendered.freeformRequestId !== undefined && posted.id) {
        registerTelegramFreeformPrompt(channel.state, {
          messageId: posted.id,
          requestId: rendered.freeformRequestId,
        });
      }
    }
  },

  async "message.completed"(event, channel, _ctx) {
    if (event.finishReason === "tool-calls" || !event.message) return;
    await channel.telegram.post(event.message);
  },

  async "step.failed"(event, channel, _ctx) {
    const notice = extractScheduledRecoveryNotice(event);
    if (notice === null) return;
    await channel.telegram.post(formatScheduledRecoveryNotice(notice));
  },

  async "turn.failed"(event, channel, _ctx) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.telegram.post(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "session.failed"(event, channel) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.telegram.post(
      [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new message to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },
};

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
