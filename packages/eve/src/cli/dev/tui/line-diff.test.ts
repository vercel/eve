import { describe, expect, it } from "vitest";

import { diffWriteDetail } from "./line-diff.js";

describe("diffWriteDetail", () => {
  it("marks every line added for a file that did not exist", () => {
    expect(diffWriteDetail(undefined, "knicks\n", false)).toEqual([
      { text: "knicks", kind: "added" },
    ]);
  });

  it("renders plain content when prior state is unknown", () => {
    expect(diffWriteDetail(undefined, "a\nb")).toEqual([{ text: "a" }, { text: "b" }]);
  });

  it("diffs an overwrite into context, removed, and added rows", () => {
    const previous = ["{", '  "dev": "eve dev",', '  "zod": "^5.6.0"', "}"].join("\n");
    const next = ["{", '  "dev": "eve dev",', '  "zod": "catalog:"', "}"].join("\n");

    expect(diffWriteDetail(previous, next)).toEqual([
      { text: "{" },
      { text: '  "dev": "eve dev",' },
      { text: '  "zod": "^5.6.0"', kind: "removed" },
      { text: '  "zod": "catalog:"', kind: "added" },
      { text: "}" },
    ]);
  });

  it("collapses unchanged stretches beyond the hunk context into a gap", () => {
    const unchanged = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
    const previous = [...unchanged, "old tail"].join("\n");
    const next = [...unchanged, "new tail"].join("\n");

    const detail = diffWriteDetail(previous, next);
    expect(detail[0]).toEqual({ text: "", kind: "gap" });
    expect(detail.slice(1)).toEqual([
      { text: "line 9" },
      { text: "line 10" },
      { text: "old tail", kind: "removed" },
      { text: "new tail", kind: "added" },
    ]);
  });

  it("windows identical content down to nothing", () => {
    expect(diffWriteDetail("same\n", "same\n")).toEqual([]);
  });

  it("does not turn a trailing newline into a phantom change", () => {
    expect(diffWriteDetail("a\nb", "a\nb\n")).toEqual([]);
  });

  it("drops trailing blank lines from the rail entirely", () => {
    expect(diffWriteDetail(undefined, "one\ntwo\n\n\n", false)).toEqual([
      { text: "one", kind: "added" },
      { text: "two", kind: "added" },
    ]);
  });

  it("falls back to plain content when the diff would be too large", () => {
    const previous = Array.from({ length: 600 }, (_, index) => `p${index}`).join("\n");
    const next = Array.from({ length: 600 }, (_, index) => `n${index}`).join("\n");

    const detail = diffWriteDetail(previous, next);
    expect(detail).toHaveLength(600);
    expect(detail.every((line) => line.kind === undefined)).toBe(true);
  });
});
