import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import { isAbsolutePosix, resolvePosix } from "./posix-path.web.ts";

describe("the POSIX path rules the browser build uses", () => {
  it("reads absolute paths like node:path", () => {
    for (const path of ["/", "/workspace", "workspace", "./a", "", "//x"]) {
      expect(isAbsolutePosix(path)).toBe(posix.isAbsolute(path));
    }
  });

  it("resolves against an absolute root like node:path", () => {
    for (const segments of [
      ["/workspace", "src/a.ts"],
      ["/workspace", "/etc/hosts"],
      ["/workspace", "../outside"],
      ["/workspace", "a/./b/../c/"],
      ["/workspace/", ""],
      ["/workspace", "..", "..", "x"],
      ["/", "a//b"],
      ["/a", "b", "/c", "d"],
    ]) {
      expect(resolvePosix(...segments)).toBe(posix.resolve(...segments));
    }
  });

  it("resolves a path with no absolute segment against the root, having no working directory", () => {
    expect(resolvePosix("a", "b")).toBe("/a/b");
  });
});
