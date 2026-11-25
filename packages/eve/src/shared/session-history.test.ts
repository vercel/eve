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
      { text: "Done", role: "assistant", toolCalls: [], steps: [] },
    ];
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(
      'history[1] has unknown fields "steps", "toolCalls". Accepted fields: id, role, text, parts.',
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
    [
      "both text and parts",
      [{ parts: [{ text: "a", type: "text" }], role: "assistant", text: "a" }],
      "history[0] takes either text or parts, not both",
    ],
    [
      "a tool call in a user message",
      [{ parts: [{ name: "x", output: 1, type: "tool" }], role: "user" }],
      "history[0].parts[0]: a user message takes only text parts",
    ],
    [
      "a tool call with no result",
      [{ parts: [{ name: "x", type: "tool" }], role: "assistant" }],
      "history[0].parts[0] must have exactly one of output",
    ],
    [
      "a tool call with both a result and an error",
      [{ parts: [{ error: "no", name: "x", output: 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0] must have exactly one of output",
    ],
    [
      "a duplicate call id",
      [
        { parts: [{ callId: "c", name: "x", output: 1, type: "tool" }], role: "assistant" },
        { parts: [{ callId: "c", error: "no", name: "x", type: "tool" }], role: "assistant" },
      ],
      'history[1].parts[0].callId "c" is not unique',
    ],
  ])("rejects %s with a precise error", (_label, history, message) => {
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(message);
  });

  it("sets the text of parts and gives each tool call an id", () => {
    const [message] = validateSessionHistory([
      {
        parts: [
          { text: "Rolling.", type: "text" },
          { input: { sides: 20 }, name: "roll_dice", output: { rolls: [3] }, type: "tool" },
          { callId: "c2", error: "Out of dice.", name: "roll_dice", type: "tool" },
          { text: "You rolled 3.", type: "text" },
        ],
        role: "assistant",
      },
    ])!;
    expect(message).toMatchObject({
      parts: [
        { text: "Rolling.", type: "text" },
        { input: { sides: 20 }, name: "roll_dice", output: { rolls: [3] }, type: "tool" },
        { callId: "c2", error: "Out of dice.", name: "roll_dice", type: "tool" },
        { text: "You rolled 3.", type: "text" },
      ],
      role: "assistant",
      text: "Rolling.\nYou rolled 3.",
    });
    expect(message?.parts?.[1]).toHaveProperty("callId", expect.stringMatching(/^history_/u));
  });
});
