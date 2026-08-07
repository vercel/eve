import { describe, expect, it } from "vitest";

import replaceInFile, { replaceExactlyOnce } from "./replace-in-file.js";

describe("replaceExactlyOnce", () => {
  it("replaces one exact match", () => {
    expect(replaceExactlyOnce("before old after", "old", "new")).toBe("before new after");
  });

  it("supports deletion", () => {
    expect(replaceExactlyOnce("before old after", "old ", "")).toBe("before after");
  });

  it("rejects a missing match", () => {
    expect(() => replaceExactlyOnce("current", "stale", "new")).toThrow(
      "oldText was not found in the current file",
    );
  });

  it("rejects a non-unique match", () => {
    expect(() => replaceExactlyOnce("same same", "same", "new")).toThrow(
      "oldText occurs more than once",
    );
  });

  it("rejects an empty match", () => {
    expect(() => replaceExactlyOnce("current", "", "new")).toThrow("oldText must not be empty");
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
      replaceInFile.execute({ filePath: "/source/file.ts", newText: "new", oldText: "old" }, {
        getSandbox: async () => sandbox,
      } as never),
    ).resolves.toEqual({ path: "/source/file.ts", replacements: 1 });
    expect(content).toBe("before new after");
  });
});
