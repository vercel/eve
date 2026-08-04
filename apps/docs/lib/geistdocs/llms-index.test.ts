import { describe, expect, it } from "vitest";
import { createLlmsIndex } from "./llms-index";

describe("createLlmsIndex", () => {
  it("follows the llms.txt index shape without frontmatter", () => {
    const output = createLlmsIndex();

    expect(output).toMatch(/^# eve\n\n> /);
    expect(output).not.toMatch(/^---/);
    expect(output).toContain("## Optional");
  });

  it("states scope and routes agents to focused, exhaustive, and version-matched docs", () => {
    const output = createLlmsIndex();

    expect(output).toContain("node_modules/eve/docs/");
    expect(output).toContain(
      "It is not a shared API, authorization server, MCP server, or A2A server",
    );
    expect(output).toContain("https://eve.dev/sitemap.md");
    expect(output).toContain("https://eve.dev/agents.md");
    expect(output).toContain("https://eve.dev/llms-full.txt");
  });

  it("uses unique absolute links and stays concise", () => {
    const output = createLlmsIndex();
    const urls = Array.from(output.matchAll(/\]\((https:\/\/[^)]+)\)/g), (match) => match[1]);

    expect(urls.length).toBeGreaterThan(20);
    expect(new Set(urls).size).toBe(urls.length);
    expect(output.length).toBeLessThan(12_000);
  });
});
