import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/telegram/defaults.js";
import type { TelegramEventContext } from "#public/channels/telegram/telegramChannel.js";

function sessionContext(userId?: string): SessionContext {
  return {
    session: {
      auth: {
        current:
          userId === undefined
            ? null
            : {
                attributes: { user_id: userId },
                authenticator: "telegram-webhook",
                principalId: `telegram:${userId}`,
                principalType: "user",
              },
        initiator: null,
      },
    },
  } as SessionContext;
}

function channelStub(chatType: "private" | "group") {
  const post = vi.fn().mockResolvedValue({ id: "message-1" });
  const request = vi.fn().mockResolvedValue({ body: {}, ok: true, status: 200 });
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const partialTelegram: Partial<TelegramEventContext["telegram"]> = {
    chatType,
    post,
    request,
    startTyping,
  };
  const partialChannel: Pick<TelegramEventContext, "telegram"> = {
    telegram: partialTelegram as TelegramEventContext["telegram"],
  };
  const channel = partialChannel as TelegramEventContext;
  return { channel, post, request, startTyping };
}

function requiredEvent() {
  return {
    authorization: { url: "https://connect.example.com/auth", userCode: "ABCD-1234" },
    description: "Connect your account to continue.",
    name: "notion",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-1",
  };
}

describe("Telegram connection authorization defaults", () => {
  it("posts the challenge directly in private chats", async () => {
    const { channel, post, request } = channelStub("private");

    await defaultEvents["authorization.required"]!(requiredEvent(), channel, sessionContext("42"));

    expect(post.mock.calls[0]?.[0]).toContain("https://connect.example.com/auth");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps group status link-free and sends the challenge to the user chat", async () => {
    const { channel, post, request } = channelStub("group");

    await defaultEvents["authorization.required"]!(requiredEvent(), channel, sessionContext("42"));

    expect(post).toHaveBeenCalledWith("Authorization required for Notion.");
    expect(request).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        chat_id: "42",
        protect_content: true,
        text: expect.stringContaining("https://connect.example.com/auth"),
      }),
    );
  });

  it("keeps the safe group status when private challenge delivery throws", async () => {
    const { channel, post, request } = channelStub("group");
    request.mockRejectedValueOnce(new Error("network unavailable"));

    await expect(
      defaultEvents["authorization.required"]!(requiredEvent(), channel, sessionContext("42")),
    ).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledWith("Authorization required for Notion.");
  });
});
