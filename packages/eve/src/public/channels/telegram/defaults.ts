import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import {
  authorizationDisplayName,
  renderAuthorizationCompleted,
  renderAuthorizationRequired,
} from "#public/channels/authorization-rendering.js";
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

/** Built-in Telegram event handlers for typing, replies, auth, HITL, and terminal errors. */
export const defaultEvents: TelegramChannelEvents = {
  async "turn.started"(_event, channel, _ctx) {
    await channel.telegram.startTyping();
  },

  async "authorization.required"(event, channel, ctx) {
    const displayName = authorizationDisplayName(event.name, event.authorization?.displayName);
    const challenge = renderAuthorizationRequired({
      authorization: event.authorization,
      description: event.description,
      name: event.name,
    });

    if (channel.telegram.chatType === "private") {
      await channel.telegram.post(challenge);
      return;
    }

    await channel.telegram.post(`Authorization required for ${displayName}.`);
    const userId = ctx.session.auth.current?.attributes.user_id;
    if (!userId) {
      log.warn("Telegram private auth challenge delivery skipped without a user id", {
        name: event.name,
      });
      return;
    }
    try {
      const response = await channel.telegram.request("sendMessage", {
        chat_id: userId,
        link_preview_options: { is_disabled: true },
        protect_content: true,
        text: challenge,
      });
      if (!response.ok) {
        log.error("Telegram private auth challenge delivery failed", {
          name: event.name,
          status: response.status,
        });
      }
    } catch (error) {
      // The public status still explains why the session is blocked when the
      // private user chat cannot be reached.
      log.error("Telegram private auth challenge delivery failed", {
        error,
        name: event.name,
      });
    }
  },

  async "authorization.completed"(event, channel, _ctx) {
    if (event.outcome === "authorized") {
      await channel.telegram.startTyping();
    }
    await channel.telegram.post(renderAuthorizationCompleted(event));
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
  if (botUsername !== undefined && mentionsBot(text, botUsername)) return true;

  return false;
}

function isBotCommand(text: string, botUsername: string | undefined): boolean {
  const match = /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u.exec(text);
  if (!match) return false;
  const target = match.groups?.target;
  if (target === undefined) return true;
  return botUsername !== undefined && target.toLowerCase() === botUsername.toLowerCase();
}

function mentionsBot(text: string, botUsername: string): boolean {
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}
