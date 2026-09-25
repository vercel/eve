import { describe, expect, it, vi } from "vitest";

import type { FrameworkMessageKind } from "#harness/messages.js";
import {
  CONTENT_ATTRIBUTE_LIMIT,
  genAiInputMessagesAttribute,
  genAiOutputMessagesAttribute,
  genAiSystemInstructionsAttribute,
  toolResultsContentAttribute,
} from "#tracing/agent-otel-content.js";

const FRAMEWORK_MESSAGE_KINDS = [
  "context.instruction",
  "context.state",
  "context.compaction",
  "memory.load",
  "execution.background_task",
  "execution.continuation",
  "execution.retry",
] as const satisfies readonly FrameworkMessageKind[];

describe("GenAI message attributes", () => {
  it.each([
    ["Buffer", () => Buffer.alloc(64, 97)],
    ["Uint8Array", () => new Uint8Array(64).fill(97)],
    ["base64", () => "a".repeat(CONTENT_ATTRIBUTE_LIMIT * 2)],
    ["data URL", () => `data:image/png;base64,${"a".repeat(CONTENT_ATTRIBUTE_LIMIT * 2)}`],
  ] as const)("omits %s attachment payloads", (_, createData) => {
    const data = createData();
    const entries = Object.entries;
    let binaryEnumerations = 0;
    const spy = vi.spyOn(Object, "entries").mockImplementation((value) => {
      if (value === data) binaryEnumerations += 1;
      return entries(value);
    });

    let attribute: string | undefined;
    try {
      attribute = genAiInputMessagesAttribute([
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize file." },
            { type: "file", mediaType: "application/octet-stream", filename: "test.bin", data },
          ],
        },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(binaryEnumerations).toBe(0);
    expect(attribute).toBe(
      '[{"parts":[{"content":"Summarize file.","type":"text"},{"type":"file"}],"role":"user"}]',
    );
  });

  it("preserves every user-message kind in the GenAI input attribute", () => {
    expect(
      genAiInputMessagesAttribute([
        { content: "A real user message.", kind: "user", role: "user" },
        {
          content: "A background task completed.",
          kind: "execution.background_task",
          role: "user",
        },
      ]),
    ).toBe(
      '[{"kind":"user","parts":[{"content":"A real user message.","type":"text"}],"role":"user"},{"kind":"execution.background_task","parts":[{"content":"A background task completed.","type":"text"}],"role":"user"}]',
    );
  });

  it.each(FRAMEWORK_MESSAGE_KINDS)("preserves %s in the GenAI input attribute", (kind) => {
    const attribute = genAiInputMessagesAttribute([
      { content: "Framework message.", kind, role: "user" },
    ]);

    expect(JSON.parse(attribute!)).toEqual([
      {
        kind,
        parts: [{ content: "Framework message.", type: "text" }],
        role: "user",
      },
    ]);
  });

  it.each([
    ["only", [{ content: "x".repeat(CONTENT_ATTRIBUTE_LIMIT + 1), role: "user" }], undefined],
    [
      "newest",
      [
        { content: "older message", role: "assistant" },
        {
          content: "x".repeat(CONTENT_ATTRIBUTE_LIMIT * 2),
          kind: "context.state",
          role: "user",
        },
      ],
      "context.state",
    ],
  ] as const)("keeps a truncated %s message when it alone exceeds the cap", (_, messages, kind) => {
    const attribute = genAiInputMessagesAttribute(messages);

    expect(attribute).toBeDefined();
    expect(attribute!.length).toBeLessThanOrEqual(CONTENT_ATTRIBUTE_LIMIT);
    const parsed = JSON.parse(attribute!) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      parts: [{ content: expect.stringMatching(/… \[truncated\]$/u), type: "text" }],
      role: "user",
    });
    expect(parsed[0]?.kind).toBe(kind);
    expect(attribute).not.toContain("older message");
  });

  it("formats model input, output, and system instructions for inspectors", () => {
    expect(
      genAiInputMessagesAttribute([
        { content: "hello", kind: "user", role: "user" },
        {
          content: [
            {
              input: { message: "echo" },
              toolCallId: "call-1",
              toolName: "delegate",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(
      '[{"kind":"user","parts":[{"content":"hello","type":"text"}],"role":"user"},{"parts":[{"arguments":{"message":"echo"},"id":"call-1","name":"delegate","type":"tool_call"}],"role":"assistant"}]',
    );
    expect(genAiSystemInstructionsAttribute("Be concise.")).toBe(
      '[{"content":"Be concise.","type":"text"}]',
    );
    expect(
      genAiOutputMessagesAttribute(
        [
          { text: "Working.", type: "text" },
          {
            callId: "call-1",
            input: { message: "echo" },
            toolName: "delegate",
            type: "tool-call",
          },
        ],
        "tool-calls",
      ),
    ).toBe(
      '[{"finish_reason":"tool_call","parts":[{"content":"Working.","type":"text"},{"arguments":{"message":"echo"},"id":"call-1","name":"delegate","type":"tool_call"}],"role":"assistant"}]',
    );
  });
});

describe("toolResultsContentAttribute", () => {
  it("returns the full payload when it fits", () => {
    const json = toolResultsContentAttribute([
      { input: { query: "weather" }, output: { results: ["sunny"] }, toolName: "web_search" },
    ]);
    expect(json).toBe(
      '[{"input":{"query":"weather"},"output":{"results":["sunny"]},"toolName":"web_search"}]',
    );
  });

  it("returns undefined for no results", () => {
    expect(toolResultsContentAttribute([])).toBeUndefined();
  });

  it("keeps oversized payloads valid JSON by capping entry text", () => {
    const json = toolResultsContentAttribute([
      {
        input: { query: "weather" },
        output: { excerpts: "x".repeat(CONTENT_ATTRIBUTE_LIMIT * 2) },
        toolName: "web_search",
      },
    ]);
    expect(json).toBeDefined();
    expect(json!.length).toBeLessThanOrEqual(CONTENT_ATTRIBUTE_LIMIT);
    const parsed = JSON.parse(json!) as Array<Record<string, unknown>>;
    expect(parsed[0]!.toolName).toBe("web_search");
    expect(parsed[0]!.input).toBe('{"query":"weather"}');
    expect(parsed[0]!.output).toContain("… [truncated]");
  });

  it("preserves the error key through truncation", () => {
    const json = toolResultsContentAttribute([
      {
        error: `quota exceeded ${"y".repeat(CONTENT_ATTRIBUTE_LIMIT * 2)}`,
        input: { query: "again" },
        toolName: "web_search",
      },
    ]);
    const parsed = JSON.parse(json!) as Array<Record<string, unknown>>;
    expect(parsed[0]!.error).toContain("quota exceeded");
    expect(parsed[0]!.error).toContain("… [truncated]");
    expect(parsed[0]!.output).toBeUndefined();
  });

  it("splits the budget across many oversized entries", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      input: { index },
      output: "z".repeat(CONTENT_ATTRIBUTE_LIMIT),
      toolName: `tool_${index}`,
    }));
    const json = toolResultsContentAttribute(entries);
    expect(json).toBeDefined();
    expect(json!.length).toBeLessThanOrEqual(CONTENT_ATTRIBUTE_LIMIT);
    const parsed = JSON.parse(json!) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(8);
    expect(parsed[7]!.toolName).toBe("tool_7");
  });
});
