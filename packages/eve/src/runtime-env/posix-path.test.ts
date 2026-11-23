import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import {
  basenamePosix,
  dirnamePosix,
  extnamePosix,
  isAbsolutePosix,
  joinPosix,
  normalizePosix,
  resolvePosix,
} from "./posix-path.web.ts";

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

  const PATHS = [
    "",
    "/",
    "//",
    "a",
    "a/",
    "/a",
    "/a/b",
    "/a/b/",
    "a/b.txt",
    ".bashrc",
    "a/.bashrc",
    "a/b.",
    "..",
    "a/..",
    "a.b.c",
    "/a//b//",
    "...",
    "./a",
  ];

  it("splits paths like node:path", () => {
    for (const path of PATHS) {
      expect(basenamePosix(path)).toBe(posix.basename(path));
      expect(dirnamePosix(path)).toBe(posix.dirname(path));
      expect(extnamePosix(path)).toBe(posix.extname(path));
    }
    expect(basenamePosix("/a/b.txt", ".txt")).toBe(posix.basename("/a/b.txt", ".txt"));
    expect(basenamePosix("/a/.txt", ".txt")).toBe(posix.basename("/a/.txt", ".txt"));
  });

  it("joins like node:path", () => {
    for (const segments of [
      [],
      [""],
      ["a", "b"],
      ["/a", "b/"],
      ["a", "../.."],
      ["/a", "../../b"],
      ["a/", "/b"],
      [".", "a"],
      ["a", ".."],
      ["/", ".."],
      ["a//b", "./c/"],
    ]) {
      expect(joinPosix(...segments)).toBe(posix.join(...segments));
    }
    for (const path of [...PATHS, "a/../../b", "/../a", "./", "a/./b/"]) {
      expect(normalizePosix(path)).toBe(posix.normalize(path));
    }
  });
});
