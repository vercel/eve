import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createUserMessage } from "#harness/messages.js";
import { changeHistory } from "#harness/session-machine/history.js";

const session = {
  compaction: { recentWindowSize: 10, threshold: 10_000 },
  history: [createUserMessage("user", "Alice asks for the weather.")],
};
const call: ModelMessage = {
  content: [{ input: {}, toolCallId: "weather-1", toolName: "weather", type: "tool-call" }],
  role: "assistant",
};
const result: ModelMessage = {
  content: [
    {
      output: { type: "text", value: "Sunny" },
      toolCallId: "weather-1",
      toolName: "weather",
      type: "tool-result",
    },
  ],
  role: "tool",
};

describe("changeHistory", () => {
  it("accepts a call followed by its result, and a call still waiting on one", () => {
    expect(changeHistory(session, { append: [call, result] }).history).toHaveLength(3);
    expect(changeHistory(session, { append: [call] }).history).toHaveLength(2);
  });

  it("rejects a result without its call, or a second result for one call", () => {
    expect(() => changeHistory(session, { append: [result] })).toThrow(
      "answers tool call weather-1, which no earlier message made",
    );
    expect(() => changeHistory(session, { append: [call, result, result] })).toThrow(
      "answers tool call weather-1 a second time",
    );
  });

  it("rejects a tool message answering a provider-executed call already answered inline", () => {
    const searched: ModelMessage = {
      content: [
        {
          input: {},
          providerExecuted: true,
          toolCallId: "search-1",
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: { type: "text", value: "Two results." },
          toolCallId: "search-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "assistant",
    };
    const again: ModelMessage = {
      content: [
        {
          output: { type: "text", value: "Two results." },
          toolCallId: "search-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "tool",
    };

    expect(changeHistory(session, { append: [searched] }).history).toHaveLength(2);
    expect(() => changeHistory(session, { append: [searched, again] })).toThrow(
      "answers tool call search-1 a second time",
    );
  });
});
