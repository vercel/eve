import { describe, expect, it } from "vitest";

import { FileContentCache } from "./file-content-cache.js";

describe("FileContentCache", () => {
  it("returns what a write replaced, fed by an earlier write", () => {
    const cache = new FileContentCache();

    expect(cache.observeWrite({ path: "/w/a.txt", content: "one", callId: "c1" })).toBeUndefined();
    expect(cache.observeWrite({ path: "/w/a.txt", content: "two", callId: "c2" })).toBe("one");
  });

  it("keeps the same previous content across re-observations of one call", () => {
    const cache = new FileContentCache();
    cache.observeWrite({ path: "/w/a.txt", content: "one", callId: "c1" });

    // The tool block re-renders on the call's result event; the write must
    // not diff against itself.
    expect(cache.observeWrite({ path: "/w/a.txt", content: "two", callId: "c2" })).toBe("one");
    expect(cache.observeWrite({ path: "/w/a.txt", content: "two", callId: "c2" })).toBe("one");
  });

  it("reconstructs a full read result into exact file content", () => {
    const cache = new FileContentCache();
    cache.observeRead({
      content: "1: alpha\n2: beta",
      path: "/w/read.txt",
      totalLines: 2,
      truncated: false,
    });

    expect(cache.observeWrite({ path: "/w/read.txt", content: "alpha\ngamma", callId: "c1" })).toBe(
      "alpha\nbeta",
    );
  });

  it("ignores truncated and windowed reads", () => {
    const cache = new FileContentCache();
    cache.observeRead({
      content: "1: alpha",
      path: "/w/read.txt",
      totalLines: 5,
      truncated: true,
    });
    cache.observeRead({
      content: "3: gamma\n4: delta",
      path: "/w/read.txt",
      totalLines: 4,
      truncated: false,
    });

    expect(
      cache.observeWrite({ path: "/w/read.txt", content: "next", callId: "c1" }),
    ).toBeUndefined();
  });

  it("ignores outputs that are not read-file results", () => {
    const cache = new FileContentCache();
    cache.observeRead({ existed: true, path: "/w/a.txt" });
    cache.observeRead(undefined);
    cache.observeRead("plain text");

    expect(cache.observeWrite({ path: "/w/a.txt", content: "x", callId: "c1" })).toBeUndefined();
  });

  it("handles an empty file read", () => {
    const cache = new FileContentCache();
    cache.observeRead({ content: "", path: "/w/empty.txt", totalLines: 0, truncated: false });

    expect(cache.observeWrite({ path: "/w/empty.txt", content: "filled", callId: "c1" })).toBe("");
  });
});
