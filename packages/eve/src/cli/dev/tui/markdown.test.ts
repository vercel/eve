import { describe, expect, it } from "vitest";

import { detectMarkdownRendering, renderMarkdown } from "./markdown.js";
import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";

describe("detectMarkdownRendering", () => {
  it("disables Markdown rendering only for an explicit false override", () => {
    expect(detectMarkdownRendering({ EVE_TUI_RENDER_MARKDOWN: "0" })).toBe(false);
    expect(detectMarkdownRendering({ EVE_TUI_RENDER_MARKDOWN: "false" })).toBe(false);
    expect(detectMarkdownRendering({ EVE_TUI_RENDER_MARKDOWN: "1" })).toBe(true);
    expect(detectMarkdownRendering({})).toBe(true);
  });
});

describe("renderMarkdown", () => {
  it("preserves underscores inside URLs", () => {
    const url =
      "https://connect.vercel.com/authorize/sca_avFI6NnYKKhA1Enmiw9LrgfDRTkNKNlCxbiwRqBkrg";
    expect(renderMarkdown(`URL: ${url}`)).toContain(url);
  });

  it("preserves underscores across multiple URLs on one line", () => {
    const challenge = "https://connect.vercel.com/authorize/sca_token_value";
    const hook =
      "http://localhost:3000/eve/v1/connections/whoami_token/callback/wrun_01KTAJ%3Aauth";
    const rendered = renderMarkdown(`${challenge} ${hook}`);
    expect(rendered).toContain(challenge);
    expect(rendered).toContain(hook);
  });

  it("separates top-level Markdown blocks even when marked absorbs source blank rows", () => {
    const rendered = stripAnsi(
      renderMarkdown("# Title\n\n## Overview\n\nParagraph.\n\n- First\n- Second\n\n---"),
    );

    expect(rendered).toBe(
      "Title\n\nOverview\n\nParagraph.\n\n• First\n• Second\n\n────────────────────────────────────────────────────────────",
    );
  });

  it("uses level-specific heading styles without a leading glyph", () => {
    expect(renderMarkdown("# one")).toBe("\x1b[1m\x1b[4mone\x1b[24m\x1b[22m");
    expect(renderMarkdown("## two")).toBe("\x1b[1mtwo\x1b[22m");
    expect(renderMarkdown("### three")).toBe("\x1b[4mthree\x1b[24m");
    expect(renderMarkdown("#### four")).toBe("\x1b[1m\x1b[2mfour\x1b[22m");
    expect(renderMarkdown("##### five")).toBe("\x1b[2m\x1b[4mfive\x1b[24m\x1b[22m");
    expect(renderMarkdown("###### six")).toBe("\x1b[2msix\x1b[22m");
  });

  it("restores heading styles after inline spans", () => {
    const linked = renderMarkdown("# [linked](https://example.com) trailing");
    expect(linked).toContain("\x1b[24m\x1b]8;;\x1b\\\x1b[4m trailing");

    const dimmed = renderMarkdown("###### **strong** trailing");
    expect(dimmed).toContain("\x1b[22m\x1b[2m trailing");
  });

  it("applies inline emphasis and muted inline code", () => {
    expect(renderMarkdown("_italic_")).toBe("\x1b[3mitalic\x1b[23m");
    expect(renderMarkdown("**bold**")).toBe("\x1b[1mbold\x1b[22m");
    expect(renderMarkdown("`code`")).toBe("\x1b[38;5;245mcode\x1b[39m");
  });

  it("renders links and images as OSC-8 underlined labels", () => {
    expect(renderMarkdown("[the docs](https://example.com)")).toBe(
      "\x1b]8;;https://example.com\x1b\\\x1b[4mthe docs\x1b[24m\x1b]8;;\x1b\\",
    );
    expect(renderMarkdown("![diagram](https://example.com/image.png)")).toBe(
      "\x1b]8;;https://example.com/image.png\x1b\\\x1b[4m▧\u00a0diagram\x1b[24m\x1b]8;;\x1b\\",
    );
  });

  it("dims list markers and aligns continuations to their visible width", () => {
    expect(renderMarkdown("1. Ordered item\n2. Another item")).toBe(
      "\x1b[2m1.\x1b[22m Ordered item\n\x1b[2m2.\x1b[22m Another item",
    );
    expect(stripAnsi(renderMarkdown("- first line  \n  continuation"))).toBe(
      "• first line\n  continuation",
    );
  });

  it("renders boxed tables and falls back to vertical rows when narrow", () => {
    const source = "| Name | Description |\n| --- | --- |\n| alpha | a very long description |";
    const wide = renderMarkdown(source, 80);
    expect(stripAnsi(wide)).toContain("┌───────┬─────────────────────────┐");
    expect(stripAnsi(wide)).toContain("│ Name  │ Description             │");
    expect(stripAnsi(wide)).toContain("├───────┼─────────────────────────┤");
    expect(stripAnsi(wide)).toContain("└───────┴─────────────────────────┘");

    const narrow = renderMarkdown(source, 18);
    expect(stripAnsi(narrow)).toContain("┌────────────────┐");
    expect(stripAnsi(narrow)).toContain("│Name: alpha     │");
    expect(stripAnsi(narrow)).toContain("│Description: a v│");
    for (const line of narrow.split("\n")) {
      expect(visibleLength(stripAnsi(line))).toBeLessThanOrEqual(18);
    }

    for (const width of [1, 2]) {
      for (const line of renderMarkdown(source, width).split("\n")) {
        expect(visibleLength(stripAnsi(line))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("replaces graphemes that cannot fit narrow code rows", () => {
    const rendered = stripAnsi(renderMarkdown("```text\n😀x\n```", 1));
    expect(rendered).toBe("?\nx");
  });
});
