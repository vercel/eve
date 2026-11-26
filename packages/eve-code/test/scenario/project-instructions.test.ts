import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RepositoryInstructionFile } from "../../extension/extension.ts";
import { discoverWorkspace } from "../../extension/lib/repositories.ts";
import { createLocalSandbox } from "./local-sandbox.ts";

async function withWorkspace(
  files: Readonly<Record<string, string>>,
  check: (read: () => Promise<RepositoryInstructionFile | null>, root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-project's-")));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
    const { sandbox, commands } = createLocalSandbox(root);
    await check(async () => {
      const discovery = await discoverWorkspace(sandbox, {
        includeWorkspaceInstructions: true,
      });
      assert.equal(commands.length, 1, "one sandbox command per read");
      commands.length = 0;
      return discovery.workspaceInstructions[0] ?? null;
    }, root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("reads AGENTS.md, falling back to CLAUDE.md when AGENTS.md is missing, empty, or whitespace-only", async () => {
  const cases: readonly [Readonly<Record<string, string>>, string | null, string | null][] = [
    [{ "AGENTS.md": "agents\n", "CLAUDE.md": "claude\n" }, "AGENTS.md", "agents\n"],
    [{ "CLAUDE.md": "claude\n" }, "CLAUDE.md", "claude\n"],
    [{ "AGENTS.md": "", "CLAUDE.md": "claude\n" }, "CLAUDE.md", "claude\n"],
    [{ "AGENTS.md": "   \n\t\n", "CLAUDE.md": "claude\n" }, "CLAUDE.md", "claude\n"],
    [{}, null, null],
  ];
  for (const [files, name, content] of cases) {
    await withWorkspace(files, async (read, root) => {
      const file = await read();
      assert.deepEqual(
        file,
        name === null
          ? null
          : {
              path: join(root, name).replaceAll("\\", "/"),
              relativePath: name,
              source: "worktree",
              content,
              truncated: false,
            },
      );
    });
  }
});

test("caps a large file in the sandbox and points the model at the rest", async () => {
  await withWorkspace({ "AGENTS.md": "x".repeat(70_000) }, async (read, root) => {
    const file = await read();
    const note = `\n\n[truncated: read ${join(root, "AGENTS.md").replaceAll("\\", "/")} for the rest]`;
    assert.equal(file?.truncated, true);
    assert.equal(file?.content, `${"x".repeat(64_000)}${note}`);
  });
});
