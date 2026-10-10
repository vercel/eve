import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ChannelResolveSession } from "#channel/channel-operations.js";
import type { Session } from "#channel/session.js";
import { createLogger } from "#internal/logging.js";
import { foldSessionEvents } from "#protocol/session-projection.js";
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
    const authorization = await findOpenAuthorization(session);
    if (authorization === undefined) {
      await inactiveAuthorization(input.telegram.telegram, input.query.id);
      return;
    }

    await input.telegram.telegram.postEphemeral(
      input.query.from.id,
      renderTelegramAuthorizationPrompt({
        authorization: authorization.signIn,
        name: authorization.name,
      }),
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

/** The latest sign-in still open. An approval responder's sign-in has its own prompt. */
async function findOpenAuthorization(session: Session) {
  const { signIns } = await foldSessionEvents(eventsToTail(session));
  return signIns.findLast((prompt) => prompt.responseId === undefined);
}

/** The session's events up to its tail when the read starts. Its stream follows the session. */
async function* eventsToTail(session: Session): AsyncGenerator<SessionStreamEvent> {
  const tailIndex = await session.getStreamTailIndex();
  if (tailIndex < 0) return;
  let index = 0;
  // Leaving the loop cancels the stream.
  for await (const event of await session.getEventStream({ startIndex: 0 })) {
    yield event;
    if (++index > tailIndex) return;
  }
}
