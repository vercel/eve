import { describe, expect, it } from "vitest";

import { reduceContentRun, selectContentRun } from "#client/content-run.js";

describe("content-run transition", () => {
  it("accumulates deltas and reconciles the full completion without duplication", () => {
    const first = reduceContentRun(undefined, { type: "append", delta: "Hel" });
    expect(first).toEqual({
      type: "update",
      run: { text: "Hel", status: "streaming" },
      delta: "Hel",
      replaced: false,
    });
    if (first.type !== "update") throw new Error("Expected an updated run");
    expect(reduceContentRun(first.run, { type: "complete", text: "Hello" })).toEqual({
      type: "update",
      run: { text: "Hello", status: "done" },
      delta: "lo",
      replaced: false,
    });
  });

  it("replaces a divergent draft rather than appending to it", () => {
    expect(
      reduceContentRun({ text: "Draft", status: "streaming" }, { type: "complete", text: "Final" }),
    ).toEqual({
      type: "update",
      run: { text: "Final", status: "done" },
      delta: "",
      replaced: true,
    });
  });

  it("opens another run under the same key after completion, but never for a null completion", () => {
    const done = { text: "Earlier", status: "done" as const };
    expect(selectContentRun(done, { type: "append", delta: "Later" })).toBe("new");
    expect(selectContentRun(done, { type: "complete", text: "Later" })).toBe("new");
    expect(selectContentRun(done, { type: "complete", text: null })).toBe("ignore");
    expect(selectContentRun(done, { type: "append", delta: "" })).toBe("ignore");
  });

  it("withdraws null completions and ignores empty deltas", () => {
    expect(reduceContentRun(undefined, { type: "append", delta: "" })).toEqual({ type: "ignore" });
    expect(
      reduceContentRun({ text: "Marker", status: "streaming" }, { type: "complete", text: null }),
    ).toEqual({ type: "remove" });
  });
});
