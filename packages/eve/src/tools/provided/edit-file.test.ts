import { describe, expect, it } from "vitest";

import type { SandboxSession } from "#public/sandbox/index.js";
import type { ToolContext } from "#tools/definition.js";
import type { ToolSchema } from "#tools/schema.js";

import { editFile, type EditFileToolEdit, type EditFileToolOutput } from "./edit-file.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function createSandbox(files: Record<string, string>) {
  const contents = new Map(
    Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]),
  );
  const sandbox: Pick<SandboxSession, "readBinaryFile" | "resolvePath" | "run" | "writeTextFile"> =
    {
      resolvePath: (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`),
      async readBinaryFile({ path }: { path: string }) {
        return contents.get(path) ?? null;
      },
      async writeTextFile({ path, content }: { path: string; content: string }) {
        await Promise.resolve();
        contents.set(path, encoder.encode(content));
      },
      async run() {
        return { exitCode: 0, stdout: "/home/alice\n", stderr: "" };
      },
    };
  const ctx = {
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox as SandboxSession,
    session: { id: "session-1" } as ToolContext["session"],
  } as ToolContext;
  return {
    read: (path: string) => decoder.decode(contents.get(path)),
    edit: async (path: string, edits: EditFileToolEdit[]) =>
      (await editFile.execute({ path, edits }, ctx)) as EditFileToolOutput,
  };
}

describe("edit_file", () => {
  it("applies every edit against the original file and keeps its BOM and CRLF endings", async () => {
    const sandbox = createSandbox({
      "/workspace/src/app.ts": "\uFEFFconst a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n",
    });

    const output = await sandbox.edit("src/app.ts", [
      { oldText: "const c = 3;", newText: "const c = 30;" },
      { oldText: "const a = 1;\nconst b = 2;", newText: "const a = 10;\nconst b = 20;" },
    ]);

    expect(sandbox.read("/workspace/src/app.ts")).toBe(
      "\uFEFFconst a = 10;\r\nconst b = 20;\r\nconst c = 30;\r\n",
    );
    expect(output).toEqual({ path: "src/app.ts", replacements: 2 });
    expect(await editFile.toModelOutput?.(output)).toEqual({
      type: "text",
      value: "Successfully replaced 2 block(s) in src/app.ts.",
    });
  });

  it("matches text that differs only in smart quotes, dashes, or trailing spaces, keeping other lines' bytes", async () => {
    const sandbox = createSandbox({
      "/workspace/notes.md": "Alice’s note  \nkeep “this” — as is\nBob – done\n",
    });

    await sandbox.edit("notes.md", [{ oldText: "Bob - done", newText: "Bob - shipped" }]);
    await sandbox.edit("notes.md", [{ oldText: "Alice's note", newText: "Alice's plan" }]);

    expect(sandbox.read("/workspace/notes.md")).toBe(
      "Alice's plan\nkeep “this” — as is\nBob - shipped\n",
    );
  });

  it.each<{ name: string; edits: EditFileToolEdit[]; message: string }>([
    {
      name: "a missing oldText",
      edits: [{ oldText: "absent", newText: "x" }],
      message:
        "Could not find the exact text in a.txt. The old text must match exactly including all whitespace and newlines.",
    },
    {
      name: "a missing oldText among several edits",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "absent", newText: "x" },
      ],
      message:
        "Could not find edits[1] in a.txt. The oldText must match exactly including all whitespace and newlines.",
    },
    {
      name: "an ambiguous oldText",
      edits: [{ oldText: "two", newText: "2" }],
      message:
        "Found 2 occurrences of the text in a.txt. The text must be unique. Please provide more context to make it unique.",
    },
    {
      name: "overlapping edits",
      edits: [
        { oldText: "one two", newText: "x" },
        { oldText: "two three", newText: "y" },
      ],
      message:
        "edits[0] and edits[1] overlap in a.txt. Merge them into one edit or target disjoint regions.",
    },
    {
      name: "an empty oldText",
      edits: [{ oldText: "", newText: "x" }],
      message: "oldText must not be empty in a.txt.",
    },
    {
      name: "an edit that changes nothing",
      edits: [{ oldText: "one", newText: "one" }],
      message:
        "No changes made to a.txt. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.",
    },
    {
      name: "no edits",
      edits: [],
      message: "Edit tool input is invalid. edits must contain at least one replacement.",
    },
  ])(
    "rejects $name with pi's message and leaves the file unchanged",
    async ({ edits, message }) => {
      const original = "one two three\ntwo\n";
      const sandbox = createSandbox({ "/workspace/a.txt": original });

      await expect(sandbox.edit("a.txt", edits)).rejects.toThrow(message);
      expect(sandbox.read("/workspace/a.txt")).toBe(original);
    },
  );

  it("reports a missing file", async () => {
    await expect(
      createSandbox({}).edit("gone.txt", [{ oldText: "a", newText: "b" }]),
    ).rejects.toThrow("Could not edit file: gone.txt. Error code: ENOENT.");
  });

  it("resolves a leading @ and ~ like pi", async () => {
    const sandbox = createSandbox({ "/home/alice/todo.txt": "draft\n" });

    await sandbox.edit("@~/todo.txt", [{ oldText: "draft", newText: "final" }]);

    expect(sandbox.read("/home/alice/todo.txt")).toBe("final\n");
  });

  it("serializes concurrent edits to the same file", async () => {
    const sandbox = createSandbox({ "/workspace/a.txt": "alpha\nbeta\n" });

    await Promise.all([
      sandbox.edit("a.txt", [{ oldText: "alpha", newText: "ALPHA" }]),
      sandbox.edit("a.txt", [{ oldText: "beta", newText: "BETA" }]),
    ]);

    expect(sandbox.read("/workspace/a.txt")).toBe("ALPHA\nBETA\n");
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "edits as a JSON string", input: { edits: '[{"oldText":"a","newText":"b"}]' } },
    { name: "a single edit object", input: { edits: { oldText: "a", newText: "b" } } },
    { name: "a top-level oldText and newText", input: { oldText: "a", newText: "b" } },
  ])("accepts $name as one edit", async ({ input }) => {
    const schema = editFile.inputSchema as ToolSchema;
    const result = await schema["~standard"].validate({ path: "a.txt", ...input });

    expect(result).toEqual({ value: { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] } });
  });
});
