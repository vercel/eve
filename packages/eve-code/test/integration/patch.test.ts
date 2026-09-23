import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxSession } from "eve/sandbox";

import {
  applyPatchToSandbox,
  deriveUpdatedContent,
  parsePatch,
} from "../../extension/lib/patch.ts";

test("parses the Codex patch operations", () => {
  assert.deepEqual(
    parsePatch(`*** Begin Patch
*** Add File: added.txt
+created
*** Update File: old.txt
*** Move to: moved.txt
@@
-before
+after
*** Delete File: removed.txt
*** End Patch`),
    [
      { type: "add", path: "added.txt", contents: "created" },
      {
        type: "update",
        path: "old.txt",
        movePath: "moved.txt",
        chunks: [
          {
            oldLines: ["before"],
            newLines: ["after"],
            changeContext: undefined,
            endOfFile: undefined,
          },
        ],
      },
      { type: "delete", path: "removed.txt" },
    ],
  );
});

test("accepts implicit first chunks and move-only updates", () => {
  assert.deepEqual(
    parsePatch(`*** Begin Patch
*** Update File: before.txt
-before
+after
*** Update File: old.txt
*** Move to: new.txt
*** End Patch`),
    [
      {
        type: "update",
        path: "before.txt",
        movePath: undefined,
        chunks: [
          {
            oldLines: ["before"],
            newLines: ["after"],
            changeContext: undefined,
            endOfFile: undefined,
          },
        ],
      },
      { type: "update", path: "old.txt", movePath: "new.txt", chunks: [] },
    ],
  );
});

test("does not reinterpret context lines as file-operation headers", () => {
  const hunks = parsePatch(`*** Begin Patch
*** Update File: source.txt
@@
 *** Delete File: victim.txt
-before
+after
*** End Patch`);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]?.type, "update");
  assert.deepEqual(hunks[0]?.type === "update" ? hunks[0].chunks[0]?.oldLines : [], [
    "*** Delete File: victim.txt",
    "before",
  ]);
});

test("accepts Codex environment metadata without treating it as an operation", () => {
  assert.deepEqual(
    parsePatch(`*** Begin Patch
*** Environment ID: sandbox-123
*** Add File: added.txt
+content
*** End Patch`),
    [{ type: "add", path: "added.txt", contents: "content" }],
  );
});

test("preserves BOM and CRLF while applying an update", () => {
  const updated = deriveUpdatedContent(
    "file.ts",
    [{ oldLines: ["const value = 1;"], newLines: ["const value = 2;"] }],
    "\uFEFFconst value = 1;\r\n",
  );
  assert.equal(updated, "\uFEFFconst value = 2;\r\n");
});

test("hunk mismatch includes nearby current file lines", () => {
  assert.throws(
    () =>
      deriveUpdatedContent(
        "src/run.ts",
        [{ oldLines: ["  const value = 1;"], newLines: ["  const value = 3;"] }],
        "export function run() {\n  const value = 2;\n  return value;\n}\n",
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed to find expected lines in src\/run\.ts/u);
      assert.match(error.message, /Expected:\n {2}const value = 1;/u);
      assert.match(error.message, /Closest current content:/u);
      assert.match(error.message, /2 \| {3}const value = 2;/u);
      assert.match(error.message, /Re-read src\/run\.ts and rewrite this hunk/u);
      return true;
    },
  );
});

test("context mismatch includes nearby current file lines", () => {
  assert.throws(
    () =>
      deriveUpdatedContent(
        "src/run.ts",
        [
          {
            changeContext: "function missing()",
            oldLines: ["  return 1;"],
            newLines: ["  return 2;"],
          },
        ],
        "export function run() {\n  return 1;\n}\n",
      ),
    /failed to find context 'function missing\(\)' in src\/run\.ts[\s\S]*Current contents from line 1:[\s\S]*Re-read src\/run\.ts/u,
  );
});

test("reports every planning failure before writing", async () => {
  const sandbox = memorySandbox({
    "/workspace/eve/stale.ts": "export const value = 2;\n",
  });
  await assert.rejects(
    applyPatchToSandbox({
      sessionId: "session-1",
      repoRoot: "/workspace/eve",
      sandbox,
      patchText: `*** Begin Patch
*** Update File: stale.ts
@@
-export const value = 1;
+export const value = 3;
*** Update File: missing.ts
@@
-missing
+changed
*** End Patch`,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed to find expected lines in stale\.ts/u);
      assert.match(error.message, /Closest current content:/u);
      assert.match(error.message, /file not found: missing\.ts/u);
      return true;
    },
  );
  assert.equal(
    await sandbox.readTextFile({ path: "/workspace/eve/stale.ts" }),
    "export const value = 2;\n",
  );
});

test("validates every operation before changing the sandbox", async () => {
  const sandbox = memorySandbox({
    "/workspace/eve/existing.txt": "before\n",
  });
  await assert.rejects(
    applyPatchToSandbox({
      sessionId: "session-1",
      repoRoot: "/workspace/eve",
      sandbox,
      patchText: `*** Begin Patch
*** Update File: existing.txt
@@
-before
+after
*** Update File: missing.txt
@@
-missing
+changed
*** End Patch`,
    }),
    /file not found: missing\.txt/u,
  );
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/existing.txt" }), "before\n");
});

test("applies add, update, move, and delete after prevalidation", async () => {
  const sandbox = memorySandbox({
    "/workspace/eve/update.txt": "before\n",
    "/workspace/eve/move.txt": "old\n",
    "/workspace/eve/delete.txt": "remove\n",
  });
  const files = await applyPatchToSandbox({
    sessionId: "session-1",
    repoRoot: "/workspace/eve",
    sandbox,
    patchText: `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: update.txt
@@
-before
+after
*** Update File: move.txt
*** Move to: moved.txt
@@
-old
+new
*** Delete File: delete.txt
*** End Patch`,
  });

  assert.deepEqual(files, [
    { operation: "add", path: "nested/new.txt" },
    { operation: "update", path: "update.txt" },
    { operation: "move", path: "moved.txt", previousPath: "move.txt" },
    { operation: "delete", path: "delete.txt" },
  ]);
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/nested/new.txt" }), "created\n");
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/update.txt" }), "after\n");
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/move.txt" }), null);
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/moved.txt" }), "new\n");
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/delete.txt" }), null);
});

test("serializes patches from distinct sandbox handles in one session", async () => {
  const sandbox = memorySandbox({ "/workspace/eve/file.txt": "one\ntwo\n" });
  const patch = (from: string, to: string) =>
    applyPatchToSandbox({
      sessionId: "session-serialized",
      repoRoot: "/workspace/eve",
      // Each ctx.getSandbox() call returns a new handle for the same sandbox.
      sandbox: { ...sandbox },
      patchText: `*** Begin Patch\n*** Update File: file.txt\n@@\n-${from}\n+${to}\n*** End Patch`,
    });

  await Promise.all([patch("one", "ONE"), patch("two", "TWO")]);

  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/file.txt" }), "ONE\nTWO\n");
});

test("collects pre-commit evidence inside the patch lock before writing", async () => {
  const sandbox = memorySandbox({ "/workspace/eve/file.txt": "before\n" });
  let observed = "";
  await applyPatchToSandbox({
    sessionId: "session-1",
    async beforeCommit(files) {
      observed = (await sandbox.readTextFile({ path: "/workspace/eve/file.txt" })) ?? "";
      assert.deepEqual(files, [{ operation: "update", path: "file.txt" }]);
    },
    repoRoot: "/workspace/eve",
    sandbox,
    patchText: `*** Begin Patch
*** Update File: file.txt
@@
-before
+after
*** End Patch`,
  });

  assert.equal(observed, "before\n");
  assert.equal(await sandbox.readTextFile({ path: "/workspace/eve/file.txt" }), "after\n");
});

test("rejects paths outside the selected repository", async () => {
  await assert.rejects(
    applyPatchToSandbox({
      sessionId: "session-1",
      repoRoot: "/workspace/eve",
      sandbox: memorySandbox({}),
      patchText: `*** Begin Patch
*** Add File: ../outside.txt
+nope
*** End Patch`,
    }),
    /invalid patch path/u,
  );
});

test("rejects paths that cross a repository symlink", async () => {
  await assert.rejects(
    applyPatchToSandbox({
      sessionId: "session-1",
      repoRoot: "/workspace/eve",
      sandbox: memorySandbox({}, { "/workspace/eve/escape/file.txt": "/workspace/other/file.txt" }),
      patchText: `*** Begin Patch
*** Add File: escape/file.txt
+nope
*** End Patch`,
    }),
    /crosses a symlink or repository boundary/u,
  );
});

test("a partial temporary write leaves the target unchanged", async () => {
  const base = memorySandbox({ "/workspace/eve/file.txt": "before\n" });
  const writeTextFile = base.writeTextFile.bind(base);
  const sandbox: SandboxSession = {
    ...base,
    async writeTextFile(options) {
      if (options.path.includes(".eve-code-") && options.path.endsWith(".tmp")) {
        await writeTextFile({ ...options, content: "partial" });
        throw new Error("disk full");
      }
      await writeTextFile(options);
    },
  };
  await assert.rejects(
    applyPatchToSandbox({
      sessionId: "session-1",
      repoRoot: "/workspace/eve",
      sandbox,
      patchText: `*** Begin Patch
*** Update File: file.txt
@@
-before
+after
*** End Patch`,
    }),
    /disk full/u,
  );
  assert.equal(await base.readTextFile({ path: "/workspace/eve/file.txt" }), "before\n");
});

function memorySandbox(
  initial: Record<string, string>,
  resolvedPaths: Readonly<Record<string, string>> = {},
): SandboxSession {
  const files = new Map(Object.entries(initial));
  return {
    resolvePath(path) {
      return path.startsWith("/") ? path : `/workspace/${path}`;
    },
    async readTextFile({ path }) {
      return files.get(path) ?? null;
    },
    async writeTextFile({ path, content }) {
      files.set(path, content);
    },
    async removePath({ path, force }) {
      if (!files.delete(path) && !force) throw new Error(`missing path: ${path}`);
    },
    async run({ command }) {
      if (command.startsWith("realpath -m -- ")) {
        const [path] = quotedArgs(command);
        return {
          exitCode: 0,
          stdout: `${resolvedPaths[path] ?? path}\n`,
          stderr: "",
        };
      }
      if (command.startsWith("mv ")) {
        const [source, target] = quotedArgs(command);
        const content = files.get(source);
        if (content === undefined) return { exitCode: 1, stdout: "", stderr: "missing source" };
        if (command.startsWith("mv -n ") && files.has(target)) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        files.set(target, content);
        files.delete(source);
      }
      if (command.startsWith("stat -c %a -- ")) {
        return { exitCode: 0, stdout: "644\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async setNetworkPolicy() {},
    async spawn() {
      throw new Error("not used by this test");
    },
    async readFile() {
      throw new Error("not used by this test");
    },
    async readBinaryFile() {
      throw new Error("not used by this test");
    },
    async writeFile() {
      throw new Error("not used by this test");
    },
    async writeBinaryFile() {
      throw new Error("not used by this test");
    },
  };
}

function quotedArgs(command: string): string[] {
  return [...command.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? "");
}
