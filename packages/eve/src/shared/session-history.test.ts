import { describe, expect, it } from "vitest";

import {
  InvalidSessionHistoryError,
  MAX_SESSION_HISTORY_CONTENT_BYTES,
  MAX_SESSION_HISTORY_MESSAGES,
  validateSessionHistory,
} from "#shared/session-history.js";

describe("validateSessionHistory", () => {
  it("keeps only contract fields and accepts empty history", () => {
    expect(validateSessionHistory(undefined)).toBeUndefined();
    expect(validateSessionHistory([])).toEqual([]);
    expect(
      validateSessionHistory([
        { content: "Hi", id: "m1", role: "user", toolCalls: [] },
        { content: "Hello", role: "assistant" },
      ]),
    ).toEqual([
      { content: "Hi", id: "m1", role: "user" },
      { content: "Hello", role: "assistant" },
    ]);
  });

  it.each([
    ["a non-array", { role: "user" }, "history must be an array"],
    ["an unknown role", [{ content: "x", role: "tool" }], 'history[0].role must be "user"'],
    ["blank content", [{ content: "  ", role: "user" }], "history[0].content must be"],
    ["non-string content", [{ content: [{ type: "text" }], role: "user" }], "history[0].content"],
    [
      "a duplicate id",
      [
        { content: "a", id: "x", role: "user" },
        { content: "b", id: "x", role: "assistant" },
      ],
      'history[1].id "x" is not unique',
    ],
    ["an overlong id", [{ content: "a", id: "x".repeat(257), role: "user" }], "history[0].id"],
    [
      "too many messages",
      Array.from({ length: MAX_SESSION_HISTORY_MESSAGES + 1 }, () => ({
        content: "a",
        role: "user",
      })),
      `the limit is ${MAX_SESSION_HISTORY_MESSAGES}`,
    ],
    [
      "too much content",
      [{ content: "a".repeat(MAX_SESSION_HISTORY_CONTENT_BYTES + 1), role: "user" }],
      `the limit is ${MAX_SESSION_HISTORY_CONTENT_BYTES}`,
    ],
  ])("rejects %s with a precise error", (_label, history, message) => {
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(message);
  });
});
