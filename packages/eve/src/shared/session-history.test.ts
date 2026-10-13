import { describe, expect, it } from "vitest";

import {
  InvalidSessionHistoryError,
  MAX_SESSION_HISTORY_TEXT_BYTES,
  MAX_SESSION_HISTORY_MESSAGES,
  validateSessionHistory,
} from "#shared/session-history.js";

describe("validateSessionHistory", () => {
  it("keeps only contract fields and accepts empty history", () => {
    expect(validateSessionHistory(undefined)).toBeUndefined();
    expect(validateSessionHistory([])).toEqual([]);
    expect(
      validateSessionHistory([
        { text: "Hi", id: "m1", role: "user", toolCalls: [] },
        { text: "Hello", role: "assistant" },
      ]),
    ).toEqual([
      { text: "Hi", id: "m1", role: "user" },
      { text: "Hello", role: "assistant" },
    ]);
  });

  it.each([
    ["a non-array", { role: "user" }, "history must be an array"],
    ["an unknown role", [{ text: "x", role: "tool" }], 'history[0].role must be "user"'],
    ["blank text", [{ text: "  ", role: "user" }], "history[0].text must be"],
    ["non-string text", [{ content: [{ type: "text" }], role: "user" }], "history[0].text"],
    [
      "a duplicate id",
      [
        { text: "a", id: "x", role: "user" },
        { text: "b", id: "x", role: "assistant" },
      ],
      'history[1].id "x" is not unique',
    ],
    ["an overlong id", [{ text: "a", id: "x".repeat(257), role: "user" }], "history[0].id"],
    [
      "too many messages",
      Array.from({ length: MAX_SESSION_HISTORY_MESSAGES + 1 }, () => ({
        text: "a",
        role: "user",
      })),
      `the limit is ${MAX_SESSION_HISTORY_MESSAGES}`,
    ],
    [
      "too much text",
      [{ text: "a".repeat(MAX_SESSION_HISTORY_TEXT_BYTES + 1), role: "user" }],
      `the limit is ${MAX_SESSION_HISTORY_TEXT_BYTES}`,
    ],
  ])("rejects %s with a precise error", (_label, history, message) => {
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(message);
  });
});
