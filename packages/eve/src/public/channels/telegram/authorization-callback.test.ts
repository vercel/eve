import { expect, it, vi } from "vitest";

import type { Session } from "#channel/session.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { dispatchTelegramAuthorizationCallback } from "#public/channels/telegram/authorization-callback.js";
import { initialTelegramState } from "#public/channels/telegram/state.js";
import type { TelegramHandle } from "#public/channels/telegram/telegramChannel.js";

const signIn = (type: string, name: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { attemptId: `att_${name}`, name, sequence: 0, stepIndex: 0, turnId: "t1", ...data },
});

/** Taps a group's Authorize button over a live session stream holding `events`. */
async function tapAuthorize(events: readonly unknown[]) {
  const telegram: Pick<TelegramHandle, "answerCallbackQuery" | "postEphemeral"> = {
    answerCallbackQuery: vi.fn(),
    postEphemeral: vi.fn(),
  };
  const session: Pick<Session, "getEventStream" | "getStreamTailIndex"> = {
    async getEventStream() {
      // The stream stays open past its tail, as a live session's does.
      return new ReadableStream<MessageStreamEvent>({
        start(controller) {
          for (const event of events) controller.enqueue(event as MessageStreamEvent);
        },
      });
    },
    async getStreamTailIndex() {
      return events.length - 1;
    },
  };
  await dispatchTelegramAuthorizationCallback({
    continuationToken: "telegram:-1001",
    query: {
      data: "eve_auth:U1",
      from: { id: "U1", isBot: false },
      id: "cb-auth",
      message: { chat: { id: "-1001", type: "supergroup" }, messageId: "55" },
      raw: {},
    },
    resolveSession: async () => session as Session,
    state: { ...initialTelegramState(undefined), chatId: "-1001" },
    telegram: { telegram: telegram as TelegramHandle },
  });
  return telegram;
}

it("sends the latest sign-in still open, not one that completed", async () => {
  const telegram = await tapAuthorize([
    signIn("authorization.required", "notion"),
    signIn("authorization.required", "linear"),
    signIn("authorization.completed", "linear", { outcome: "authorized" }),
  ]);

  expect(telegram.postEphemeral).toHaveBeenCalledWith(
    "U1",
    expect.objectContaining({ text: "Authorization required for Notion." }),
    { callbackQueryId: "cb-auth" },
  );
});

it("tells the requester a completed sign-in is no longer active", async () => {
  const telegram = await tapAuthorize([
    signIn("authorization.required", "notion"),
    signIn("authorization.completed", "notion", { outcome: "authorized" }),
  ]);

  expect(telegram.postEphemeral).not.toHaveBeenCalled();
  expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({
    callbackQueryId: "cb-auth",
    showAlert: true,
    text: "This authorization request is no longer active.",
  });
});
