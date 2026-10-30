import { describe, expect, it } from "vitest";

import { isPathInsideOrEqual } from "#shared/path-inside.js";

describe("isPathInsideOrEqual", () => {
  it.each([
    ["/app", "/app", true],
    ["/app/agent/tools/a.ts", "/app", true],
    ["/app/..cache/file", "/app", true],
    ["/app/agent/../x", "/app", true],
    ["/srv/app", "/", true],
    ["/application", "/app", false],
    ["/app/../other", "/app", false],
    ["/", "/app", false],
  ])("%s inside %s → %s", (path, directory, expected) => {
    expect(isPathInsideOrEqual(path, directory)).toBe(expected);
  });
});
