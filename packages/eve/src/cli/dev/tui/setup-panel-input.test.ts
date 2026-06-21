import { describe, expect, it } from "vitest";

import { lineOf } from "./line-editor.js";
import { renderAcknowledgeQuestion, renderTextQuestion } from "./setup-panel.js";
import { stripAnsi } from "./terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });
const colorTheme = createTheme({ color: true, unicode: true });

describe("renderTextQuestion", () => {
  it("paints the message, input line, and hints", () => {
    const rows = renderTextQuestion(
      { message: "Project name", editor: lineOf("my-agent"), mask: false },
      theme,
      60,
      true,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("  Project name");
    // The input line sits directly under the message — no blank row between.
    expect(rows[1]).toContain("my-agent");
    expect(text).toContain("enter to submit · esc to cancel");
  });

  it("draws the blinking cursor as a block over the grapheme under it", () => {
    const rows = renderTextQuestion(
      {
        message: "Project name",
        editor: { text: "hello", cursor: 3 },
        mask: false,
      },
      colorTheme,
      60,
      true,
    );
    const input = rows[1] ?? "";

    expect(stripAnsi(input)).toBe("  hello");
    expect(input).toContain(colorTheme.colors.inverse("l"));
    expect(input).not.toContain(colorTheme.glyph.caret);
  });

  it("draws the block over the first placeholder grapheme", () => {
    const rows = renderTextQuestion(
      {
        message: "API key",
        editor: lineOf(""),
        mask: true,
        placeholder: "type your key",
      },
      colorTheme,
      60,
      true,
    );
    const input = rows[1] ?? "";

    expect(stripAnsi(input)).toBe("  type your key");
    expect(input).toContain(colorTheme.colors.inverse("t"));
  });

  it("paints notices above the message, gone with the question", () => {
    const rows = renderTextQuestion(
      {
        message: "New project name",
        editor: lineOf(""),
        mask: false,
        notices: [{ tone: "warning", text: "Project named 'x' already exists in 'team'" }],
      },
      theme,
      60,
      true,
    );

    expect(rows[0]).toBe("⚠ Project named 'x' already exists in 'team'");
    expect(rows[1]).toBe("  New project name");
  });

  it("masks one bullet per grapheme", () => {
    const text = renderTextQuestion(
      { message: "API key", editor: lineOf("e\u0301👨‍👩‍👧‍👦"), mask: true },
      theme,
      60,
      false,
    ).join("\n");

    expect(text).toContain("••");
    expect(text).not.toContain("•••");
    expect(text).not.toContain("👨");
  });
});

describe("renderAcknowledgeQuestion", () => {
  it("paints the heading, dim body lines, and an enter-only footer", () => {
    const rows = renderAcknowledgeQuestion(
      {
        message: "Using another model provider",
        lines: ["Set your provider's API key in .env.local.", "Point your agent at it."],
      },
      theme,
      60,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("  Using another model provider");
    expect(text).toContain("Set your provider's API key in .env.local.");
    expect(text).toContain("Point your agent at it.");
    expect(text).toContain("enter to continue");
    expect(text).not.toContain("esc");
  });

  it("omits the body gap when there are no lines", () => {
    const rows = renderAcknowledgeQuestion({ message: "All set", lines: [] }, theme, 60);

    expect(rows[0]).toBe("  All set");
    expect(rows.filter((row) => row.trim().length > 0)).toHaveLength(2);
  });
});
