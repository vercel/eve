import { describe, expect, it } from "vitest";

import { type Block, renderBlockLines } from "./blocks.js";
import { stripAnsi, visibleLength } from "./terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });
const ctx = { spinner: "⠋" };

function render(block: Block, width = 60): string[] {
  return renderBlockLines(block, width, theme, ctx).map(stripAnsi);
}

describe("renderBlockLines", () => {
  it("renders a user message behind a left bar", () => {
    expect(render({ kind: "user", body: "hello there" })).toEqual(["▌ hello there"]);
  });

  it("marks the assistant with the brand triangle", () => {
    const lines = render({ kind: "assistant", body: "all done" });
    expect(lines[0]).toBe("▲ all done");
  });

  it("summarizes a completed tool with a result line", () => {
    const lines = render({
      kind: "tool",
      title: "get_weather",
      subtitle: 'city="SF"',
      status: "done",
      result: "73°F",
    });
    expect(lines[0]).toBe('✓ get_weather  city="SF"');
    expect(lines[1]).toBe("  → 73°F");
  });

  it("shows a spinner while a tool runs", () => {
    const lines = render({ kind: "tool", title: "search", status: "running", live: true });
    expect(lines[0]).toBe("⠋ search");
  });

  it("nests subagent tools under the orange rule", () => {
    const lines = render({
      kind: "subagent-tool",
      depth: 1,
      title: "fetch",
      status: "done",
      result: "ok",
    });
    expect(lines[0]?.startsWith("│ ✓ fetch")).toBe(true);
  });

  it("collapses reasoning to a single line when requested", () => {
    expect(render({ kind: "reasoning", body: "long trace", collapsed: true })).toEqual([
      "○ thinking",
    ]);
  });

  it("never exceeds the available width", () => {
    const long = "lorem ipsum ".repeat(40).trim();
    for (const line of render({ kind: "assistant", body: long }, 40)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });

  it("wraps a long question prompt instead of overflowing the row", () => {
    const prompt =
      "Which repository or repositories should the tool check? " +
      "Please provide them in the format owner/repo.";
    const lines = render({ kind: "question", title: prompt, body: "  (type your answer)" }, 40);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toBe("? Which repository or repositories");
    expect(lines[1]).toBe("  should the tool check? Please provide");
    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });

  it("renders a dim notice line", () => {
    expect(render({ kind: "notice", body: "Started a new session." })).toEqual([
      "· Started a new session.",
    ]);
  });

  it("renders a multi-line log run with the label once and a hanging indent", () => {
    const indent = " ".repeat("stderr · ".length);
    const lines = render({
      kind: "log",
      title: "stderr",
      body: "turn completed {\n  sessionId: 'x',\n  turnId: 't',\n  sequence: 0\n}",
    });
    expect(lines).toEqual([
      "│ stderr · turn completed {",
      `│ ${indent}  sessionId: 'x',`,
      `│ ${indent}  turnId: 't',`,
      `│ ${indent}  sequence: 0`,
      `│ ${indent}}`,
    ]);
  });

  it("renders a one-line log with its source label", () => {
    const lines = render({ kind: "log", title: "stdout", body: "weather lookup { city: 'SF' }" });
    expect(lines).toEqual(["│ stdout · weather lookup { city: 'SF' }"]);
  });

  it("renders sandbox lifecycle lines as first-class progress", () => {
    const lines = render(
      {
        kind: "sandbox",
        body: 'built sandbox template "root" on backend "microsandbox".',
      },
      100,
    );
    expect(lines).toEqual(['│ sandbox · built sandbox template "root" on backend "microsandbox".']);
  });

  it("suppresses the label when sandbox progress continues", () => {
    const indent = " ".repeat("sandbox · ".length);
    const lines = renderBlockLines(
      {
        kind: "sandbox",
        body: 'sandbox template "root" (microsandbox): apt-get update',
      },
      80,
      theme,
      { spinner: "⠋", previous: { kind: "sandbox" } },
    ).map(stripAnsi);
    expect(lines).toEqual([`│ ${indent}sandbox template "root" (microsandbox): apt-get update`]);
  });

  it("suppresses the label when a log continues a same-source run", () => {
    const indent = " ".repeat("stdout · ".length);
    const lines = renderBlockLines(
      { kind: "log", title: "stdout", body: "weather lookup { city: 'LA' }" },
      60,
      theme,
      { spinner: "⠋", previous: { kind: "log", title: "stdout" } },
    ).map(stripAnsi);
    expect(lines).toEqual([`│ ${indent}weather lookup { city: 'LA' }`]);
  });

  it("keeps the label when the previous log block has a different source", () => {
    const lines = renderBlockLines({ kind: "log", title: "stderr", body: "boom" }, 60, theme, {
      spinner: "⠋",
      previous: { kind: "log", title: "stdout" },
    }).map(stripAnsi);
    expect(lines).toEqual(["│ stderr · boom"]);
  });

  it("renders an error's diagnostic detail beneath the headline", () => {
    const lines = render(
      {
        kind: "error",
        title: "Error",
        body: "TypeError: Cannot read properties of undefined",
        detail:
          "TypeError: Cannot read properties of undefined (reading 'temperature')\n    at getWeather (agent/tools.ts:12:5)",
      },
      100,
    );
    expect(lines[0]).toBe("⨯ Error");
    expect(lines[1]).toBe("  TypeError: Cannot read properties of undefined");
    expect(lines[2]).toBe(
      "  TypeError: Cannot read properties of undefined (reading 'temperature')",
    );
    expect(lines[3]).toBe("      at getWeather (agent/tools.ts:12:5)");
  });

  it("caps long error detail dumps and clips stack frames to one row each", () => {
    const frames = Array.from({ length: 20 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`);
    const lines = render({
      kind: "error",
      title: "Error",
      body: "boom",
      detail: ["Error: boom", ...frames].join("\n"),
    });
    // Headline + body + 12 detail rows + the "+N more" marker.
    expect(lines).toHaveLength(2 + 12 + 1);
    expect(lines.at(-1)).toBe("  … +9 more lines");
    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(60);
    }
  });
});

describe("error block coloring", () => {
  const colorTheme = createTheme({ color: true, unicode: true });

  it("draws docs URLs in the cyan link color", () => {
    const rows = renderBlockLines(
      {
        kind: "error",
        title: "Error",
        body: "HookConflictError: token in use\n╰▶ docs: https://workflow-sdk.dev/err/hook-conflict",
      },
      80,
      colorTheme,
      ctx,
    );
    const docsRow = rows.find((row) => row.includes("workflow-sdk.dev"));
    expect(docsRow).toBeDefined();
    // The cyan SGR (36) wraps the URL; the surrounding text stays red (31).
    expect(docsRow).toContain("\x1b[36m");
    expect(docsRow).toContain("\x1b[31m");
  });
});
