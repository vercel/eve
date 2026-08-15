import { describe, expect, it } from "vitest";

import {
  CONTENT_ATTRIBUTE_LIMIT,
  genAiInputMessagesAttribute,
  genAiOutputMessagesAttribute,
  genAiSystemInstructionsAttribute,
  toolResultsContentAttribute,
} from "#tracing/agent-otel-content.js";

describe("GenAI message attributes", () => {
  it("formats model input, output, and system instructions for inspectors", () => {
    expect(
      genAiInputMessagesAttribute([
        { content: "hello", role: "user" },
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
      '[{"parts":[{"content":"hello","type":"text"}],"role":"user"},{"parts":[{"arguments":{"message":"echo"},"id":"call-1","name":"delegate","type":"tool_call"}],"role":"assistant"}]',
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
