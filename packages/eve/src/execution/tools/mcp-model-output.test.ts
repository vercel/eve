import { describe, expect, it } from "vitest";

import { mcpToolResultToModelOutput } from "#execution/tools/mcp-model-output.js";

describe("mcpToolResultToModelOutput", () => {
  it("sends only the text content, not the envelope or structuredContent", () => {
    const rows = { rows: [{ BILLED_SEATS: 132 }], success: true };
    expect(
      mcpToolResultToModelOutput({
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
        content: [{ text: JSON.stringify(rows), type: "text" }],
        isError: false,
        resultType: "complete",
        structuredContent: rows,
      }),
    ).toEqual({ type: "text", value: JSON.stringify(rows) });
  });

  it("joins multiple text blocks", () => {
    expect(
      mcpToolResultToModelOutput({
        content: [
          { text: "first", type: "text" },
          { text: "second", type: "text" },
        ],
      }),
    ).toEqual({ type: "text", value: "first\nsecond" });
  });

  it("marks error results", () => {
    expect(
      mcpToolResultToModelOutput({
        content: [{ text: "no such table", type: "text" }],
        isError: true,
      }),
    ).toEqual({ type: "text", value: "Tool call failed:\nno such table" });
    expect(mcpToolResultToModelOutput({ content: [], isError: true })).toEqual({
      type: "text",
      value: "Tool call failed.",
    });
    expect(
      mcpToolResultToModelOutput({
        content: [],
        isError: true,
        structuredContent: { code: "NOT_FOUND" },
      }),
    ).toEqual({ type: "text", value: 'Tool call failed:\n{"code":"NOT_FOUND"}' });
  });

  it("falls back to structuredContent when content is empty", () => {
    expect(mcpToolResultToModelOutput({ content: [], structuredContent: { count: 3 } })).toEqual({
      type: "json",
      value: { count: 3 },
    });
  });

  it("maps images, audio, and embedded resources to content parts", () => {
    expect(
      mcpToolResultToModelOutput({
        content: [
          { text: "Screenshot:", type: "text" },
          { data: "aW1n", mimeType: "image/png", type: "image" },
          { data: "YXVk", mimeType: "audio/wav", type: "audio" },
          { resource: { text: "readme", uri: "file:///README.md" }, type: "resource" },
          { resource: { blob: "YmxvYg==", uri: "file:///a.bin" }, type: "resource" },
          { name: "spec", type: "resource_link", uri: "file:///spec.md" },
        ],
      }),
    ).toEqual({
      type: "content",
      value: [
        { text: "Screenshot:", type: "text" },
        { data: { data: "aW1n", type: "data" }, mediaType: "image/png", type: "file" },
        { data: { data: "YXVk", type: "data" }, mediaType: "audio/wav", type: "file" },
        { text: "readme", type: "text" },
        {
          data: { data: "YmxvYg==", type: "data" },
          mediaType: "application/octet-stream",
          type: "file",
        },
        {
          text: JSON.stringify({ name: "spec", type: "resource_link", uri: "file:///spec.md" }),
          type: "text",
        },
      ],
    });
  });

  it("passes through values that are not CallToolResults", () => {
    expect(mcpToolResultToModelOutput("plain")).toEqual({ type: "text", value: "plain" });
    expect(mcpToolResultToModelOutput({ ok: true })).toEqual({ type: "json", value: { ok: true } });
    expect(mcpToolResultToModelOutput({ content: "not blocks" })).toEqual({
      type: "json",
      value: { content: "not blocks" },
    });
    expect(mcpToolResultToModelOutput(undefined)).toEqual({ type: "json", value: null });
  });
});
