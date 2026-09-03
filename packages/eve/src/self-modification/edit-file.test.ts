import { describe, expect, it } from "vitest";

import editFile, { applyExactEdits } from "./extension/tools/edit_file.js";

describe("applyExactEdits", () => {
  it("replaces one exact match", () => {
    expect(applyExactEdits("before old after", [{ oldText: "old", newText: "new" }])).toBe(
      "before new after",
    );
  });

  it("applies multiple disjoint edits against the original content", () => {
    expect(
      applyExactEdits("a b", [
        { oldText: "a", newText: "b" },
        { oldText: "b", newText: "c" },
      ]),
    ).toBe("b c");
  });

  it("supports deletion", () => {
    expect(applyExactEdits("before old after", [{ oldText: "old ", newText: "" }])).toBe(
      "before after",
    );
  });

  it("rejects a missing match", () => {
    expect(() => applyExactEdits("current", [{ oldText: "stale", newText: "new" }])).toThrow(
      "oldText was not found in the current file",
    );
  });

  it("rejects a non-unique match", () => {
    expect(() => applyExactEdits("same same", [{ oldText: "same", newText: "new" }])).toThrow(
      "oldText occurs more than once",
    );
  });

  it("rejects overlapping edits", () => {
    expect(() =>
      applyExactEdits("before old after", [
        { oldText: "old", newText: "new" },
        { oldText: "before old", newText: "before new" },
      ]),
    ).toThrow("overlap");
  });

  it("rejects an empty edit list", () => {
    expect(() => applyExactEdits("current", [])).toThrow(
      "edits must contain at least one replacement",
    );
  });

  it("rejects an empty match", () => {
    expect(() => applyExactEdits("current", [{ oldText: "", newText: "new" }])).toThrow(
      "oldText must not be empty",
    );
  });

  it("edits the current sandbox file", async () => {
    let content = "before old after";
    const sandbox = {
      readTextFile: async () => content,
      resolvePath: (path: string) => path,
      writeTextFile: async (input: { readonly content: string }) => {
        content = input.content;
      },
    };

    await expect(
      editFile.execute(
        {
          edits: [{ newText: "new", oldText: "old" }],
          path: "/source/file.ts",
        },
        {
          getSandbox: async () => sandbox,
        } as never,
      ),
    ).resolves.toEqual({ path: "/source/file.ts", replacements: 1 });
    expect(content).toBe("before new after");
  });
});
