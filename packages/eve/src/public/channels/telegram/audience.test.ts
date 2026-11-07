import { describe, expect, it } from "vitest";

import { telegramInstrumentation } from "#public/channels/telegram/audience.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";

function space(input: Partial<TelegramChannelState>) {
  return telegramInstrumentation.space({ state: input as TelegramChannelState });
}

describe("telegram space", () => {
  it.each([
    ["private", "direct"],
    ["group", "group"],
    ["supergroup", "channel"],
    ["channel", "channel"],
  ] as const)("reports a %s chat as %s", (chatType, type) => {
    expect(space({ chatId: "42", chatType })).toEqual({ id: "telegram:42", type });
  });

  it("reports none without a chat", () => {
    expect(space({ chatId: null, chatType: "private" })).toBeUndefined();
  });
});
