import { describe, expect, it } from "vitest";

import { InvalidSessionHistoryError, validateSessionHistory } from "#shared/session-history.js";

describe("validateSessionHistory", () => {
  it("normalizes contract fields and accepts empty history", () => {
    expect(validateSessionHistory(undefined)).toBeUndefined();
    expect(validateSessionHistory([])).toEqual([]);
    expect(
      validateSessionHistory([
        { text: "Hi", id: "m1", role: "user" },
        { text: "Hello", id: undefined, role: "assistant", parts: undefined },
      ]),
    ).toEqual([
      { text: "Hi", id: "m1", role: "user" },
      { text: "Hello", role: "assistant" },
    ]);
  });

  it("rejects fields outside the contract instead of dropping them", () => {
    const history = [
      { text: "Hi", role: "user" },
      { text: "Done", role: "assistant", toolCalls: [], parts: [] },
    ];
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(
      'history[1] has unknown fields "parts", "toolCalls". Accepted fields: id, role, text.',
    );
  });

  it.each([
    ["a non-array", { role: "user" }, "history must be an array"],
    ["an unknown role", [{ text: "x", role: "tool" }], 'history[0].role must be "user"'],
    ["blank text", [{ text: "  ", role: "user" }], "history[0].text must be"],
    ["non-string text", [{ text: 42, role: "user" }], "history[0].text"],
    [
      "a duplicate id",
      [
        { text: "a", id: "x", role: "user" },
        { text: "b", id: "x", role: "assistant" },
      ],
      'history[1].id "x" is not unique',
    ],
  ])("rejects %s with a precise error", (_label, history, message) => {
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(message);
  });
});
