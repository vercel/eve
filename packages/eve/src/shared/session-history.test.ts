import { describe, expect, it } from "vitest";

import {
  InvalidSessionHistoryError,
  toImportedHistoryMessages,
  validateSessionHistory,
} from "#shared/session-history.js";

describe("validateSessionHistory", () => {
  it("normalizes shorthand text entries and accepts empty history", () => {
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

  it("validates structured parts including user files, narration, completed tool calls, errors, and tool-only steps", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const input = [
      {
        id: "u1",
        parts: [
          { text: "Is ticket T-1 open?", type: "text" },
          {
            data: "https://example.com/report.pdf",
            filename: "report.pdf",
            mediaType: "application/pdf",
            type: "file",
          },
          { data: new URL("https://example.com/photo.png"), mediaType: "image/png", type: "file" },
          { data: bytes, mediaType: "application/pdf", type: "file" },
        ],
        role: "user",
      },
      {
        parts: [
          { text: "Checking T-1.", type: "text" },
          {
            input: { id: "T-1" },
            name: "lookup_ticket",
            output: { status: "open" },
            type: "tool",
          },
          { error: "Timed out", name: "list_notes", type: "tool" },
          { name: "count_tickets", output: null, type: "tool" },
          { text: "T-1 is open, but its notes did not load.", type: "text" },
        ],
        role: "assistant",
      },
      {
        parts: [{ name: "step_only", output: "ok", type: "tool" }],
        role: "assistant",
      },
    ] as const;

    expect(validateSessionHistory(input)).toEqual(input);
  });

  it("rejects fields outside the contract instead of dropping them", () => {
    const history = [
      { text: "Hi", role: "user" },
      { text: "Done", role: "assistant", files: [], toolCalls: [] },
    ];
    expect(() => validateSessionHistory(history)).toThrow(InvalidSessionHistoryError);
    expect(() => validateSessionHistory(history)).toThrow(
      'history[1] has unknown fields "files", "toolCalls". Accepted fields: id, role, text, parts.',
    );
  });

  it.each([
    ["a non-array", { role: "user" }, "history must be an array"],
    ["an unknown role", [{ text: "x", role: "tool" }], 'history[0].role must be "user"'],
    ["blank text", [{ text: "  ", role: "user" }], "history[0].text must be"],
    ["non-string text", [{ text: 42, role: "user" }], "history[0].text"],
    [
      "both text and parts",
      [{ parts: [{ text: "Hi", type: "text" }], role: "user", text: "Hi" }],
      "history[0] must have exactly one of text or parts.",
    ],
    [
      "neither text nor parts",
      [{ role: "assistant" }],
      "history[0] must have exactly one of text or parts.",
    ],
    [
      "empty parts array",
      [{ parts: [], role: "assistant" }],
      "history[0].parts must be a non-empty array.",
    ],
    [
      "non-array parts",
      [{ parts: {}, role: "user" }],
      "history[0].parts must be a non-empty array.",
    ],
    [
      "a tool part on a user message",
      [{ parts: [{ name: "lookup", output: 1, type: "tool" }], role: "user" }],
      'history[0].parts[0] with type "tool" is only accepted on an assistant message.',
    ],
    [
      "an unsupported user part type",
      [{ parts: [{ text: "hmm", type: "reasoning" }], role: "user" }],
      'history[0].parts[0].type must be "text" or "file".',
    ],
    [
      "a file part on an assistant message",
      [
        {
          parts: [
            { data: "https://example.com/a.pdf", mediaType: "application/pdf", type: "file" },
          ],
          role: "assistant",
        },
      ],
      'history[0].parts[0] with type "file" is only accepted on a user message.',
    ],
    [
      "a file part with an unknown field",
      [
        {
          parts: [
            {
              data: "https://example.com/a.pdf",
              mediaType: "application/pdf",
              type: "file",
              url: "https://example.com/a.pdf",
            },
          ],
          role: "user",
        },
      ],
      'history[0].parts[0] has unknown field "url". Accepted fields: type, mediaType, filename, data.',
    ],
    [
      "a file part with blank mediaType",
      [
        {
          parts: [{ data: "https://example.com/a.pdf", mediaType: " ", type: "file" }],
          role: "user",
        },
      ],
      "history[0].parts[0].mediaType must be a non-empty string.",
    ],
    [
      "a file part with blank filename",
      [
        {
          parts: [
            {
              data: "https://example.com/a.pdf",
              filename: "  ",
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
      "history[0].parts[0].filename must be a non-empty string.",
    ],
    [
      "a file part with empty string data",
      [{ parts: [{ data: "", mediaType: "application/pdf", type: "file" }], role: "user" }],
      "history[0].parts[0].data must be a non-empty string.",
    ],
    [
      "a file part with blank string data",
      [{ parts: [{ data: "   ", mediaType: "application/pdf", type: "file" }], role: "user" }],
      "history[0].parts[0].data must be a non-empty string.",
    ],
    [
      "a file part with an empty data URL string",
      [
        {
          parts: [
            { data: "data:application/pdf;base64,", mediaType: "application/pdf", type: "file" },
          ],
          role: "user",
        },
      ],
      "history[0].parts[0].data must be non-empty.",
    ],
    [
      "a file part with an empty data URL object",
      [
        {
          parts: [
            {
              data: new URL("data:application/pdf;base64,"),
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
      "history[0].parts[0].data must be non-empty.",
    ],
    [
      "a file part with empty Uint8Array data",
      [
        {
          parts: [{ data: new Uint8Array(), mediaType: "application/pdf", type: "file" }],
          role: "user",
        },
      ],
      "history[0].parts[0].data must be non-empty.",
    ],
    [
      "a file part with non-file data",
      [{ parts: [{ data: 123, mediaType: "application/pdf", type: "file" }], role: "user" }],
      "history[0].parts[0].data must be a non-empty string, URL, Uint8Array, or ArrayBuffer.",
    ],
    [
      "a file part with an internal ref scheme string",
      [
        {
          parts: [
            {
              data: "eve-sandbox:?path=/a&size=1&type=application/pdf",
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
      "history[0].parts[0].data must not use a framework-internal ref scheme.",
    ],
    [
      "a file part with an internal ref scheme URL",
      [
        {
          parts: [
            {
              data: new URL("eve-url:https://example.com/a.pdf"),
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
      "history[0].parts[0].data must not use a framework-internal ref scheme.",
    ],
    [
      "an unsupported assistant part type",
      [{ parts: [{ text: "hmm", type: "reasoning" }], role: "assistant" }],
      'history[0].parts[0].type must be "text" or "tool".',
    ],
    [
      "blank text part",
      [{ parts: [{ text: "  ", type: "text" }], role: "assistant" }],
      "history[0].parts[0].text must be a non-empty string.",
    ],
    [
      "unknown field on a text part",
      [{ parts: [{ extra: true, text: "Hi", type: "text" }], role: "user" }],
      'history[0].parts[0] has unknown field "extra". Accepted fields: type, text.',
    ],
    [
      "a tool part with an invalid name",
      [{ parts: [{ name: "bad name!", output: 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0].name must be 1 to 64 ASCII letters, digits, underscores, or dashes.",
    ],
    [
      "a tool part with a name over 64 characters",
      [{ parts: [{ name: "a".repeat(65), output: 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0].name must be 1 to 64 ASCII letters, digits, underscores, or dashes.",
    ],
    [
      "a tool part without output or error",
      [{ parts: [{ input: {}, name: "lookup", type: "tool" }], role: "assistant" }],
      "history[0].parts[0] must have exactly one of output or error.",
    ],
    [
      "a tool part with both output and error",
      [{ parts: [{ error: "boom", name: "lookup", output: 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0] must have exactly one of output or error.",
    ],
    [
      "a tool part with blank error",
      [{ parts: [{ error: "   ", name: "lookup", type: "tool" }], role: "assistant" }],
      "history[0].parts[0].error must be a non-empty string.",
    ],
    [
      "a tool part with null input",
      [{ parts: [{ input: null, name: "lookup", output: 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0].input must be a JSON object.",
    ],
    [
      "a tool part with array input",
      [{ parts: [{ input: [1, 2], name: "lookup", output: 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0].input must be a JSON object.",
    ],
    [
      "a tool part with non-JSON output",
      [{ parts: [{ name: "lookup", output: () => 1, type: "tool" }], role: "assistant" }],
      "history[0].parts[0].output must be a JSON value.",
    ],
    [
      "a tool part with a __proto__ key in input",
      [
        {
          parts: [
            {
              input: JSON.parse('{"__proto__":{"isAdmin":true},"id":"T-1"}'),
              name: "lookup",
              output: "ok",
              type: "tool",
            },
          ],
          role: "assistant",
        },
      ],
      "history[0].parts[0].input cannot contain prototype keys.",
    ],
    [
      "a tool part with a nested __proto__ key in output",
      [
        {
          parts: [
            {
              name: "lookup",
              output: JSON.parse('[{"__proto__":{"polluted":true}}]'),
              type: "tool",
            },
          ],
          role: "assistant",
        },
      ],
      "history[0].parts[0].output cannot contain prototype keys.",
    ],
    [
      "a tool part with pending/unknown fields",
      [
        {
          parts: [{ id: "c1", name: "lookup", output: 1, state: "pending", type: "tool" }],
          role: "assistant",
        },
      ],
      'history[0].parts[0] has unknown fields "id", "state". Accepted fields: type, name, input, output, error.',
    ],
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

describe("toImportedHistoryMessages", () => {
  it("preserves plain text entries and projects structured parts with joined text and safe file metadata", () => {
    expect(
      toImportedHistoryMessages([
        { id: "m1", role: "user", text: "Hello" },
        {
          id: "u2",
          parts: [
            { text: "Review this contract.", type: "text" },
            {
              data: "eve-url:https://example.com/contract.pdf",
              filename: "contract.pdf",
              mediaType: "application/pdf",
              type: "file",
            },
            {
              data: "data:image/png;base64,iVBORw0K",
              filename: "chart.png",
              mediaType: "image/png",
              type: "file",
            },
            {
              data: "chatjs-file://private/123",
              filename: "notes.txt",
              mediaType: "text/plain",
              type: "file",
            },
          ],
          role: "user",
        },
        {
          id: "m2",
          parts: [
            { text: "Checking.", type: "text" },
            { input: { id: "T-1" }, name: "lookup_ticket", output: { open: true }, type: "tool" },
            { text: "It is open.", type: "text" },
          ],
          role: "assistant",
        },
        {
          parts: [{ error: "Timed out", name: "list_notes", type: "tool" }],
          role: "assistant",
        },
      ]),
    ).toEqual([
      { id: "m1", role: "user", text: "Hello" },
      {
        id: "u2",
        parts: [
          { text: "Review this contract.", type: "text" },
          {
            filename: "contract.pdf",
            mediaType: "application/pdf",
            type: "file",
            url: "https://example.com/contract.pdf",
          },
          {
            filename: "chart.png",
            mediaType: "image/png",
            size: 6,
            type: "file",
            unavailable: true,
          },
          {
            filename: "notes.txt",
            mediaType: "text/plain",
            type: "file",
            unavailable: true,
          },
        ],
        role: "user",
        text: "Review this contract.",
      },
      {
        id: "m2",
        parts: [
          { text: "Checking.", type: "text" },
          { input: { id: "T-1" }, name: "lookup_ticket", output: { open: true }, type: "tool" },
          { text: "It is open.", type: "text" },
        ],
        role: "assistant",
        text: "Checking.\nIt is open.",
      },
      {
        parts: [{ error: "Timed out", name: "list_notes", type: "tool" }],
        role: "assistant",
        text: "",
      },
    ]);
  });
});
