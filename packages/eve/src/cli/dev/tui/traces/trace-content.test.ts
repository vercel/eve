import { describe, expect, it } from "vitest";

import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";

import { createTheme } from "../theme.js";
import { formatAttributeContent } from "./trace-content.js";

const THEME = createTheme({ color: false, unicode: true });
const WIDTH = 60;

function format(key: string, value: unknown, width = WIDTH): string[] {
  return formatAttributeContent(key, value, THEME, width).map(stripAnsi);
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
      THEME,
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
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "Hi! What city?" },
          { type: "tool-call", toolName: "get_weather", input: { city: "nyc" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "get_weather",
            output: { type: "text", value: "sunny, 72F" },
          },
        ],
      },
    ]);
    expect(format("ai.prompt.messages", messages)).toEqual([
      "user: test",
      "assistant: ⟨reasoning⟩",
      "  Hi! What city?",
      '  → get_weather({"city":"nyc"})',
      "tool get_weather: sunny, 72F",
    ]);
  });

  it("keeps wrapped continuations indented under their block", () => {
    const longText = "word ".repeat(30).trim();
    const messages = JSON.stringify([{ role: "assistant", content: longText }]);
    const lines = format("ai.prompt.messages", messages, 40);
    expect(lines[0]).toMatch(/^assistant: /);
    for (const line of lines.slice(1)) expect(line).toMatch(/^ {2}\S/);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(40);
    // No content word is lost in wrapping.
    expect(lines.join(" ").match(/word/g)).toHaveLength(30);
  });

  it("unwraps typed tool output envelopes", () => {
    const messages = JSON.stringify([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "get_weather",
            output: { type: "json", value: { city: "nyc", temperatureF: 72 } },
          },
        ],
      },
    ]);
    expect(format("ai.prompt.messages", messages)).toEqual([
      'tool get_weather: {"city":"nyc","temperatureF":72}',
    ]);
  });

  it("falls back to pretty JSON for non-message payloads", () => {
    const notMessages = JSON.stringify([{ notARole: true }]);
    expect(format("ai.prompt.messages", notMessages)).toEqual([
      "[",
      "  {",
      '    "notARole": true',
      "  }",
      "]",
    ]);
  });

  it("keeps unparseable strings raw", () => {
    expect(format("ai.prompt.messages", "not json at all")).toEqual(["not json at all"]);
  });

  it("renders the truncation marker as a notice before the kept messages", () => {
    const messages = JSON.stringify([
      { "eve.truncated": { omittedMessages: 47 } },
      { role: "user", content: "latest question" },
    ]);
    expect(format("ai.prompt.messages", messages)).toEqual([
      "… 47 earlier messages omitted (long context)",
      "user: latest question",
    ]);
  });

  it("splits embedded newlines in payload text into separate lines", () => {
    const messages = JSON.stringify([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "load_skill",
            output: { type: "text", value: "line one.\nline two.\n" },
          },
        ],
      },
    ]);
    const lines = format("ai.prompt.messages", messages);
    expect(lines).toEqual(["tool load_skill: line one.", "  line two."]);
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
      { role: "user", content: "hello\x1b[31mred\x1b[0m world" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "safe\x1b[2Jtext" },
          { type: "tool-call", toolName: "evil\x1b[?1000h", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "evil\x1b[?1000h",
            output: { type: "text", value: "r\x1besult" },
          },
        ],
      },
    ]);
    const lines = format("ai.prompt.messages", messages);
    const joined = lines.join("\n");
    expect(joined).not.toContain("\x1b");
    expect(joined).toContain("hello");
    expect(joined).toContain("red");
    expect(joined).toContain("safe[2Jtext");
  });
});
