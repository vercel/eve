import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import { executeWriteFileOnSandbox } from "#execution/sandbox/write-file.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { SandboxSession } from "#public/sandbox/index.js";
import type { ToolContext } from "#tools/definition.js";
import type { ToolSchema } from "#tools/schema.js";

import { editFile, type EditFileToolEdit, type EditFileToolOutput } from "./edit-file.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function createSandbox(
  files: Record<string, string | Uint8Array>,
  options: { mode?: string } = {},
) {
  const commands: string[] = [];
  const contents = new Map(
    Object.entries(files).map(([path, file]) => [
      path,
      typeof file === "string" ? encoder.encode(file) : file,
    ]),
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
      async run({ command }: { command: string }) {
        commands.push(command);
        if (command.startsWith("stat ")) {
          return {
            exitCode: options.mode === undefined ? 1 : 0,
            stdout: `${options.mode ?? ""}\n`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "/home/alice\n", stderr: "" };
      },
    };
  const ctx = {
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox as SandboxSession,
    session: { id: "session-1" } as ToolContext["session"],
  } as ToolContext;
  return {
    commands,
    read: (path: string) => decoder.decode(contents.get(path)),
    bytes: (path: string) => contents.get(path),
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

  it("resolves a leading @, ~, and $HOME to the sandbox home", async () => {
    const sandbox = createSandbox({ "/home/alice/todo.txt": "one\n" });

    await sandbox.edit("@~/todo.txt", [{ oldText: "one", newText: "two" }]);
    await sandbox.edit("$HOME/todo.txt", [{ oldText: "two", newText: "three" }]);

    expect(sandbox.read("/home/alice/todo.txt")).toBe("three\n");
  });

  it("rejects a file that is not UTF-8 instead of rewriting its bytes", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6c, 0x64, 0x0a]);
    const sandbox = createSandbox({ "/workspace/menu.txt": latin1 });

    await expect(sandbox.edit("menu.txt", [{ oldText: "old", newText: "new" }])).rejects.toThrow(
      "Could not edit file: menu.txt. It is not valid UTF-8 text.",
    );
    expect(sandbox.bytes("/workspace/menu.txt")).toEqual(latin1);
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

  it("leaves a file it edited writable by write_file after read_file", async () => {
    const sandbox = mockSandbox({ initialFiles: { "notes.md": "draft\n" } });
    const path = sandbox.session.resolvePath("notes.md");
    const ctx = {
      abortSignal: new AbortController().signal,
      getSandbox: async () => sandbox.session as SandboxSession,
      session: { id: "session-1" } as ToolContext["session"],
    } as ToolContext;

    await contextStorage.run(new ContextContainer(), async () => {
      await executeReadFileOnSandbox(sandbox.session, { filePath: "notes.md" });
      await editFile.execute(
        { path: "notes.md", edits: [{ oldText: "draft", newText: "plan" }] },
        ctx,
      );
      await executeWriteFileOnSandbox(sandbox.session, {
        content: "final\n",
        filePath: "notes.md",
      });
    });

    expect(sandbox.files.get(path)).toBe("final\n");
  });

  it("restores a file mode other than the sandbox default after writing", async () => {
    const executable = createSandbox({ "/workspace/bin/run": "echo old\n" }, { mode: "755" });
    const regular = createSandbox({ "/workspace/notes.md": "old\n" }, { mode: "644" });

    await executable.edit("bin/run", [{ oldText: "old", newText: "new" }]);
    await regular.edit("notes.md", [{ oldText: "old", newText: "new" }]);

    expect(executable.commands.at(-1)).toBe("chmod 755 -- '/workspace/bin/run'");
    expect(regular.commands.some((command) => command.startsWith("chmod"))).toBe(false);
  });

  it("still rejects write_file after a change made since read_file", async () => {
    const sandbox = mockSandbox({ initialFiles: { "notes.md": "draft\n" } });
    const path = sandbox.session.resolvePath("notes.md");
    const ctx = {
      abortSignal: new AbortController().signal,
      getSandbox: async () => sandbox.session as SandboxSession,
      session: { id: "session-1" } as ToolContext["session"],
    } as ToolContext;

    const write = contextStorage.run(new ContextContainer(), async () => {
      await executeReadFileOnSandbox(sandbox.session, { filePath: "notes.md" });
      // A formatter rewrites the file after the read.
      await sandbox.session.writeTextFile({ path, content: "draft\nformatted\n" });
      await editFile.execute(
        { path: "notes.md", edits: [{ oldText: "draft", newText: "plan" }] },
        ctx,
      );
      await executeWriteFileOnSandbox(sandbox.session, {
        content: "final\n",
        filePath: "notes.md",
      });
    });

    await expect(write).rejects.toThrow("modified since it was last read");
    expect(sandbox.files.get(path)).toBe("plan\nformatted\n");
  });
});
