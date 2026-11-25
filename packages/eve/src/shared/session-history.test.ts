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
      { text: "Done", role: "assistant", files: [], parts: [] },
    ];
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(
      'history[1] has unknown fields "files", "parts". Accepted fields: id, role, text, toolCalls.',
    );
  });

  it("keeps an assistant message's completed and failed tool calls in order", () => {
    expect(
      validateSessionHistory([
        { text: "Is ticket T-1 open?", role: "user" },
        {
          text: "T-1 is open, but its notes did not load.",
          role: "assistant",
          toolCalls: [
            { name: "lookup_ticket", input: { id: "T-1" }, output: { status: "open" } },
            { name: "list_notes", error: "Timed out", input: undefined, output: undefined },
            { name: "count_tickets", output: null },
          ],
        },
        { text: "No calls here.", role: "assistant", toolCalls: [] },
      ]),
    ).toEqual([
      { text: "Is ticket T-1 open?", role: "user" },
      {
        text: "T-1 is open, but its notes did not load.",
        role: "assistant",
        toolCalls: [
          { name: "lookup_ticket", input: { id: "T-1" }, output: { status: "open" } },
          { name: "list_notes", error: "Timed out" },
          { name: "count_tickets", output: null },
        ],
      },
      { text: "No calls here.", role: "assistant" },
    ]);
  });

  it.each([
    [
      "calls on a user message",
      { role: "user", toolCalls: [{ name: "lookup", output: 1 }] },
      "history[0].toolCalls is only accepted on an assistant message.",
    ],
    ["calls that are not an array", { toolCalls: {} }, "history[0].toolCalls must be an array"],
    ["a call that is not an object", { toolCalls: ["lookup"] }, "toolCalls[0] must be an object."],
    ["a call without a name", { toolCalls: [{ output: 1 }] }, "toolCalls[0].name must be"],
    [
      "a call without a result",
      { toolCalls: [{ name: "lookup", input: {} }] },
      "history[0].toolCalls[0] must have exactly one of output or error.",
    ],
    [
      "a call with both an output and an error",
      { toolCalls: [{ name: "lookup", output: 1, error: "Timed out" }] },
      "history[0].toolCalls[0] must have exactly one of output or error.",
    ],
    [
      "an empty error",
      { toolCalls: [{ name: "lookup", error: "" }] },
      "toolCalls[0].error must be",
    ],
    [
      "an input that is not JSON",
      { toolCalls: [{ name: "lookup", input: { at: new Date(0) }, output: 1 }] },
      "history[0].toolCalls[0].input must be a JSON value.",
    ],
    [
      "an output that is not JSON",
      { toolCalls: [{ name: "lookup", output: () => 1 }] },
      "history[0].toolCalls[0].output must be a JSON value.",
    ],
    [
      "a pending call's fields",
      {
        toolCalls: [
          { name: "lookup", output: 1 },
          { name: "save", state: "pending", id: "c1" },
        ],
      },
      'history[0].toolCalls[1] has unknown fields "id", "state". Accepted fields: name, input, output, error.',
    ],
  ])("rejects %s with a precise error", (_label, entry, message) => {
    const history = [{ role: "assistant", text: "Done.", ...entry }];
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(message);
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
