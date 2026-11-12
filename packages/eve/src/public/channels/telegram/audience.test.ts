import { describe, expect, it } from "vitest";

import { telegramInstrumentation } from "#public/channels/telegram/audience.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";

function space(input: Partial<TelegramChannelState>) {
  return telegramInstrumentation.space({ state: input as TelegramChannelState });
}

describe("telegram space", () => {
  it.each([
    ["private", { type: "direct", visibility: "private" }],
    ["group", { type: "shared", visibility: "private" }],
    // A supergroup or channel may have a public link, which the chat type doesn't say.
    ["supergroup", { type: "shared" }],
    ["channel", { type: "shared" }],
  ] as const)("reports a %s chat as %o", (chatType, expected) => {
    expect(space({ chatId: "42", chatType })).toEqual({ id: "telegram:42", ...expected });
  });

  it("reports none without a chat", () => {
    expect(space({ chatId: null, chatType: "private" })).toBeUndefined();
  });
});
