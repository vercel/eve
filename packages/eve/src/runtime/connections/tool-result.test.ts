import { describe, expect, it } from "vitest";

import type { ConnectionToolMetadata } from "#shared/connection-types.js";

import {
  connectionToolModelOutput,
  toConnectionToolResult,
  type ConnectionToolResult,
} from "./tool-result.js";

// The kennel e2e eval covers structured content, JSON text, images, and text
// errors end to end. These cover the result-contract branches it cannot reach.

const tool: ConnectionToolMetadata = { name: "t", description: "", inputSchema: {} };
const typed: ConnectionToolMetadata = { ...tool, outputSchema: { type: "string" } };

interface ResultCase {
  readonly name: string;
  readonly protocol?: "mcp" | "openapi";
  readonly tool: ConnectionToolMetadata;
  readonly raw: unknown;
  readonly expected: ConnectionToolResult;
}

describe("toConnectionToolResult", () => {
  it.each<ResultCase>([
    {
      name: "keeps JSON-looking text as text when the tool declares an output schema",
      tool: typed,
      raw: { content: [{ type: "text", text: '{"a":1}' }] },
      expected: { ok: true, value: '{"a":1}' },
    },
    {
      name: "keeps text that is not valid JSON",
      tool,
      raw: { content: [{ type: "text", text: "{not json" }] },
      expected: { ok: true, value: "{not json" },
    },
    {
      name: "reports structured content for an error without text",
      tool,
      raw: { isError: true, content: [], structuredContent: { code: "busy" } },
      expected: { ok: false, error: '{"code":"busy"}' },
    },
    {
      name: "reports a generic error when an error has no detail",
      tool,
      raw: { isError: true, content: [] },
      expected: { ok: false, error: "The tool reported an error." },
    },
    {
      name: "passes OpenAPI responses through unchanged",
      protocol: "openapi",
      tool,
      raw: { status: 200, statusText: "OK", body: { isError: true } },
      expected: { ok: true, value: { status: 200, statusText: "OK", body: { isError: true } } },
    },
  ])("$name", ({ protocol = "mcp", tool, raw, expected }) => {
    expect(toConnectionToolResult(protocol, tool, raw)).toEqual(expected);
  });
});

describe("connectionToolModelOutput", () => {
  it("turns resource blobs into named file parts and other resources into text", () => {
    expect(
      connectionToolModelOutput([
        {
          type: "resource",
          resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: "UERG" },
        },
        { type: "resource", resource: { uri: "file:///notes.txt", text: "hello" } },
        { type: "resource_link", name: "report", uri: "https://example.com/r" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      ]),
    ).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          data: { type: "data", data: "UERG" },
          mediaType: "application/pdf",
          filename: "file:///a.pdf",
        },
        { type: "text", text: "file:///notes.txt\nhello" },
        { type: "text", text: "Resource link: report https://example.com/r" },
        { type: "file", data: { type: "data", data: "AAAA" }, mediaType: "audio/wav" },
      ],
    });
  });
});
