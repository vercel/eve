import { describe, expect, it } from "vitest";

import { compactedSinceLastUserMessage } from "#harness/compaction/openai-item.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

const item: StoredHistoryMessage = {
  content: [
    {
      kind: "openai.compaction",
      providerOptions: { openai: { encryptedContent: "ENC", itemId: "cmp_1" } },
      type: "custom",
    },
  ],
  role: "assistant",
};
const user = (text: string): StoredHistoryMessage => ({
  content: text,
  kind: "user",
  role: "user",
});
const reply: StoredHistoryMessage = {
  content: [{ text: "Noted.", type: "text" }],
  role: "assistant",
};

describe("compactedSinceLastUserMessage", () => {
  it("finds the item when it is the last message", () => {
    expect(compactedSinceLastUserMessage([user("Review it."), item])).toBe(true);
  });

  it("finds the item when OpenAI returns messages after it", () => {
    expect(compactedSinceLastUserMessage([user("Review it."), item, reply])).toBe(true);
  });

  it("finds the item after the user messages OpenAI keeps beside it", () => {
    expect(compactedSinceLastUserMessage([user("One."), user("Two."), item])).toBe(true);
  });

  it("ignores an item the user has spoken after", () => {
    expect(compactedSinceLastUserMessage([user("One."), item, reply, user("Two.")])).toBe(false);
  });

  it("is false for a history without the item", () => {
    expect(compactedSinceLastUserMessage([user("One."), reply])).toBe(false);
    expect(compactedSinceLastUserMessage([])).toBe(false);
  });
});
