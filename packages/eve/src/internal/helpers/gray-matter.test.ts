import { describe, expect, it } from "vitest";

import { hasFrontmatter, parseFrontmatter } from "#internal/helpers/gray-matter.js";

describe("parseFrontmatter", () => {
  it("parses YAML frontmatter into data and body", () => {
    const doc = parseFrontmatter("---\ntitle: T\n---\nhello");
    expect(doc.data).toEqual({ title: "T" });
    expect(doc.content.trim()).toBe("hello");
  });

  it("rejects a JavaScript frontmatter fence by default without evaluating it", () => {
    const marker = "eve_gray_matter_default_marker";
    const source = `---js\n(globalThis[${JSON.stringify(marker)}] = true)\n---\n`;

    expect(() => parseFrontmatter(source)).toThrow(/JavaScript frontmatter is not supported/);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("evaluates a JavaScript fence only when allowCodeEngines is opted in", () => {
    const marker = "eve_gray_matter_optin_marker";
    const source = `---js\n(globalThis[${JSON.stringify(marker)}] = true)\n---\n`;

    parseFrontmatter(source, { allowCodeEngines: true });
    expect((globalThis as Record<string, unknown>)[marker]).toBe(true);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("detects a leading frontmatter delimiter", () => {
    expect(hasFrontmatter("---\ntitle: T\n---\n")).toBe(true);
    expect(hasFrontmatter("no frontmatter")).toBe(false);
  });
});
