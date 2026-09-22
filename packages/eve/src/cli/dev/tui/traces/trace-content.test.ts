import { describe, expect, it } from "vitest";

import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";

import { createTheme } from "../theme.js";
import { formatAttributeContent } from "./trace-content.js";

const THEME = createTheme({ color: false, unicode: true });
const WIDTH = 60;

function format(key: string, value: unknown, width = WIDTH): string[] {
  return formatAttributeContent(key, value, THEME.colors.dim, width).map(stripAnsi);
}

describe("formatAttributeContent", () => {
  it("passes scalars through on one line", () => {
    expect(format("gen_ai.request.model", "gpt-5")).toEqual(["gpt-5"]);
    expect(format("agent.usage.input_tokens", 1234)).toEqual(["1234"]);
  });

  it("sanitizes non-string attribute values instead of String()ing them", () => {
    // OTLP array attributes can carry strings with raw escape sequences.
    // Assert on the unstripped output — stripAnsi would mask an injection.
    const raw = formatAttributeContent(
      "agent.session.ids",
      ["safe", "evil\x1b[2J\x1b]0;owned\x07text"],
      THEME.colors.dim,
      WIDTH,
    ).join("\n");
    expect(raw).not.toContain("\x1b");
    expect(raw).not.toContain("\x07");
    expect(raw).toContain("evil");
    expect(format("agent.flag", true)).toEqual(["true"]);
  });

  it("pretty-prints JSON payloads", () => {
    expect(format("gen_ai.tool.call.arguments", '{"city":"SF","unit":"f"}')).toEqual([
      "{",
      '  "city": "SF",',
      '  "unit": "f"',
      "}",
    ]);
  });

  it("renders prompt messages as role-prefixed blocks", () => {
    const messages = JSON.stringify([
      { role: "user", parts: [{ type: "text", content: "test" }] },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "" },
          { type: "text", content: "Hi! What city?" },
          { type: "tool_call", id: "call-1", name: "get_weather", arguments: { city: "nyc" } },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "call-1", response: "sunny, 72F" }],
      },
    ]);
    expect(format("gen_ai.input.messages", messages)).toEqual([
      "user: test",
      "assistant: ⟨reasoning⟩",
      "  Hi! What city?",
      '  → get_weather({"city":"nyc"})',
      "tool get_weather: sunny, 72F",
    ]);
  });

  it("keeps wrapped continuations indented under their block", () => {
    const longText = "word ".repeat(30).trim();
    const messages = JSON.stringify([
      { role: "assistant", parts: [{ type: "text", content: longText }] },
    ]);
    const lines = format("gen_ai.input.messages", messages, 40);
    expect(lines[0]).toMatch(/^assistant: /);
    for (const line of lines.slice(1)) expect(line).toMatch(/^ {2}\S/);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(40);
    // No content word is lost in wrapping.
    expect(lines.join(" ").match(/word/g)).toHaveLength(30);
  });

  it("renders structured tool responses", () => {
    const messages = JSON.stringify([
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "call-1",
            response: { city: "nyc", temperatureF: 72 },
          },
        ],
      },
    ]);
    expect(format("gen_ai.input.messages", messages)).toEqual([
      'tool: {"city":"nyc","temperatureF":72}',
    ]);
  });

  it("falls back to pretty JSON for non-message payloads", () => {
    const notMessages = JSON.stringify([{ notARole: true }]);
    expect(format("gen_ai.input.messages", notMessages)).toEqual([
      "[",
      "  {",
      '    "notARole": true',
      "  }",
      "]",
    ]);
  });

  it("keeps unparseable strings raw", () => {
    expect(format("gen_ai.input.messages", "not json at all")).toEqual(["not json at all"]);
  });

  it("splits embedded newlines in payload text into separate lines", () => {
    const messages = JSON.stringify([
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "call-1",
            response: "line one.\nline two.\n",
          },
        ],
      },
    ]);
    const lines = format("gen_ai.input.messages", messages);
    expect(lines).toEqual(["tool: line one.", "  line two."]);
    for (const line of lines) expect(line).not.toContain("\n");
  });

  it("splits newlines in raw values too", () => {
    expect(format("custom.payload", "first\nsecond\r\nthird\r")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("strips terminal escape sequences from roles, content, and tool names", () => {
    const messages = JSON.stringify([
      {
        role: "user",
        parts: [{ type: "text", content: "hello\x1b[31mred\x1b[0m world" }],
      },
      {
        role: "assistant",
        parts: [
          { type: "text", content: "safe\x1b[2Jtext" },
          { type: "tool_call", id: "call-1", name: "evil\x1b[?1000h", arguments: {} },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "call-1",
            response: "r\x1besult",
          },
        ],
      },
    ]);
    const lines = format("gen_ai.input.messages", messages);
    const joined = lines.join("\n");
    expect(joined).not.toContain("\x1b");
    expect(joined).toContain("hello");
    expect(joined).toContain("red");
    expect(joined).toContain("safe[2Jtext");
  });
});
