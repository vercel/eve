import { describe, expect, it } from "vitest";

import { hasFrontmatter, parseFrontmatter, parseYaml } from "#internal/helpers/frontmatter.js";

describe("parseFrontmatter", () => {
  it.each([
    ["LF", "---\ntitle: T\n---\nhello\n"],
    ["CRLF", "---\r\ntitle: T\r\n---\r\nhello\r\n"],
    ["a byte order mark", "\uFEFF---\ntitle: T\n---\nhello\n"],
    ["an explicit yaml fence", "---yaml\ntitle: T\n---\nhello\n"],
  ])("splits frontmatter and body with %s", (_label, source) => {
    const document = parseFrontmatter(source);
    expect(document?.data).toEqual({ title: "T" });
    expect(document?.content.trimEnd()).toBe("hello");
  });

  it("parses an empty block to an empty object", () => {
    expect(parseFrontmatter("---\n---\nbody")).toEqual({ data: {}, content: "body" });
  });

  it.each([
    ["no opening fence", "title: T\n---\n"],
    ["a horizontal rule", "----\ntitle: T\n----\n"],
    ["no closing fence", "---\ntitle: T\nbody"],
  ])("returns undefined for %s", (_label, source) => {
    expect(parseFrontmatter(source)).toBeUndefined();
  });

  it.each(["js", "javascript", "coffee"])(
    "rejects a %s fence without evaluating it",
    (language) => {
      const marker = `eve_frontmatter_${language}_marker`;
      const source = `---${language}\n(globalThis[${JSON.stringify(marker)}] = true)\n---\n`;

      expect(() => parseFrontmatter(source)).toThrow(`Frontmatter language "${language}"`);
      expect(Reflect.get(globalThis, marker)).toBeUndefined();
    },
  );

  it("refuses code-evaluating YAML tags", () => {
    expect(() =>
      parseFrontmatter('---\nrun: !!js/function "function () { return 1; }"\n---\n'),
    ).toThrow(/unknown tag/);
  });
});

describe("hasFrontmatter", () => {
  it.each([
    ["---\ntitle: T\n---\n", true],
    ["---js\n1\n---\n", true],
    ["\uFEFF---\n", true],
    ["----\n", false],
    ["no frontmatter", false],
  ])("detects the opening fence in %j", (source, expected) => {
    expect(hasFrontmatter(source)).toBe(expected);
  });
});

describe("parseYaml", () => {
  it.each([
    ["a plain YAML file", "name: test\n"],
    ["a fenced YAML file", "---\nname: test\n---\n"],
    ["a leading document marker without a closing fence", "---\nname: test\n"],
  ])("parses %s", (_label, source) => {
    expect(parseYaml(source)).toEqual({ name: "test" });
  });

  it.each(["", "# comment only\n"])("parses %j to an empty object", (source) => {
    expect(parseYaml(source)).toEqual({});
  });
});
