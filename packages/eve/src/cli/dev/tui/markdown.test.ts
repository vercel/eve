import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";

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

  it("still applies emphasis to non-URL text", () => {
    expect(renderMarkdown("_italic_")).toBe("\x1b[3mitalic\x1b[23m");
    expect(renderMarkdown("**bold**")).toBe("\x1b[1mbold\x1b[22m");
  });

  it("applies emphasis around a shielded URL", () => {
    const rendered = renderMarkdown("see _https://example.com/a_b_ now");
    expect(rendered).toContain("https://example.com/a_b");
  });

  it("renders fenced code, task lists, links, and strikethrough semantically", () => {
    const rendered = renderMarkdown(
      "- [x] Read [the docs](https://example.com)\n\n~~~ts\nconst ok = true;\n~~~\n\n~~old~~",
    );

    expect(rendered).toContain("• ☑ Read the docs (\x1b[36mhttps://example.com\x1b[39m)");
    expect(rendered).toContain("  \x1b[2mts\x1b[22m");
    expect(rendered).toContain("\x1b[2m│\x1b[22m \x1b[36mconst ok = true;\x1b[39m");
    expect(rendered).toContain("\x1b[9mold\x1b[29m");
  });

  it("fits wide tables to the available terminal width", () => {
    const rendered = renderMarkdown(
      "| Name | Description |\n| --- | --- |\n| alpha | a very long description |",
      24,
    );

    for (const line of rendered.split("\n")) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(24);
    }
    expect(rendered).toContain("…");
  });
});
