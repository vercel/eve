import { describe, expect, it } from "vitest";

import { endsWithOpenAICompaction } from "#harness/compaction/openai-item.js";
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

const injected: StoredHistoryMessage = {
  content: "STATE-NOTE",
  kind: "context.state",
  role: "user",
};
const toolResult: StoredHistoryMessage = {
  content: [
    {
      output: { type: "text", value: "Two cases." },
      toolCallId: "call_1",
      toolName: "lookup",
      type: "tool-result",
    },
  ],
  role: "tool",
};

describe("endsWithOpenAICompaction", () => {
  it("is true when the item is the last message", () => {
    expect(endsWithOpenAICompaction([user("Review it."), item])).toBe(true);
  });

  it("is true when only messages eve injects follow the item", () => {
    expect(endsWithOpenAICompaction([user("Review it."), item, injected])).toBe(true);
  });

  it("is false once a tool result follows the item, in the same turn", () => {
    expect(endsWithOpenAICompaction([user("Review it."), item, reply, toolResult])).toBe(false);
  });

  it("is false once the user has spoken after the item", () => {
    expect(endsWithOpenAICompaction([user("One."), item, reply, user("Two.")])).toBe(false);
  });

  it("is false for a history without the item", () => {
    expect(endsWithOpenAICompaction([user("One."), reply])).toBe(false);
    expect(endsWithOpenAICompaction([])).toBe(false);
  });
});
