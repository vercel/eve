import type { ChannelResolveSession } from "#channel/channel-operations.js";
import type { Session } from "#channel/session.js";
import { createLogger } from "#internal/logging.js";
import type { AuthorizationRequiredStreamEvent } from "#protocol/message.js";
import {
  TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX,
  renderTelegramAuthorizationPrompt,
} from "#public/channels/telegram/authorization.js";
import type { TelegramCallbackQuery } from "#public/channels/telegram/inbound.js";
import type {
  TelegramChannelState,
  TelegramContext,
} from "#public/channels/telegram/telegramChannel.js";

const log = createLogger("telegram.authorization-callback");

export async function dispatchTelegramAuthorizationCallback(input: {
  readonly continuationToken: string;
  readonly query: TelegramCallbackQuery;
  readonly resolveSession: ChannelResolveSession;
  readonly state: TelegramChannelState;
  readonly telegram: TelegramContext;
}): Promise<void> {
  const expectedUserId = input.query.data?.slice(TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX.length);
  if (expectedUserId !== input.query.from.id) {
    await input.telegram.telegram.answerCallbackQuery({
      callbackQueryId: input.query.id,
      showAlert: true,
      text: "Only the requester can authorize this connection.",
    });
    return;
  }
  if (!input.query.message || !input.state.chatId) return;

  try {
    const session = await input.resolveSession(input.continuationToken);
    if (session === undefined) {
      await inactiveAuthorization(input.telegram.telegram, input.query.id);
      return;
    }
    const authorization = await findPendingAuthorization(session);
    if (authorization === undefined) {
      await inactiveAuthorization(input.telegram.telegram, input.query.id);
      return;
    }

    await input.telegram.telegram.postEphemeral(
      input.query.from.id,
      renderTelegramAuthorizationPrompt(authorization.data),
      { callbackQueryId: input.query.id },
    );
    await input.telegram.telegram.answerCallbackQuery({
      callbackQueryId: input.query.id,
      text: "Sign-in prompt sent privately.",
    });
  } catch (error) {
    log.error("Telegram authorization callback delivery failed", { error });
  }
}

async function inactiveAuthorization(
  telegram: TelegramContext["telegram"],
  callbackQueryId: string,
) {
  await telegram.answerCallbackQuery({
    callbackQueryId,
    showAlert: true,
    text: "This authorization request is no longer active.",
  });
}

async function findPendingAuthorization(
  session: Session,
): Promise<AuthorizationRequiredStreamEvent | undefined> {
  const tailIndex = await session.getStreamTailIndex();
  if (tailIndex < 0) return undefined;
  const events = await session.getEventStream({ startIndex: 0 });
  const reader = events.getReader();
  let authorization: AuthorizationRequiredStreamEvent | undefined;
  try {
    for (let index = 0; index <= tailIndex; index += 1) {
      const next = await reader.read();
      if (next.done) break;
      if (
        next.value.type === "authorization.required" &&
        next.value.data.candidateId === undefined
      ) {
        authorization = next.value;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return authorization;
}
