import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  type ProjectInstructionsFile,
  readProjectInstructions,
} from "../../extension/lib/project-instructions.ts";

const execFileAsync = promisify(execFile);

/** Runs the reader's one command with local bash against a temporary workspace. */
async function withWorkspace(
  files: Readonly<Record<string, string>>,
  check: (read: () => Promise<ProjectInstructionsFile | null>, root: string) => Promise<void>,
): Promise<void> {
  // A quote in the root path proves the command quotes its paths.
  const root = await mkdtemp(join(tmpdir(), "eve-code-project's-"));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
    const commands: string[] = [];
    const sandbox = {
      resolvePath: (path: string) => join(root, path),
      async run({ command }: { command: string }) {
        commands.push(command);
        const { stdout, stderr } = await execFileAsync("bash", ["-c", command]);
        return { exitCode: 0, stdout, stderr };
      },
    };
    await check(async () => {
      const file = await readProjectInstructions(sandbox);
      assert.equal(commands.length, 1, "one sandbox command per read");
      commands.length = 0;
      return file;
    }, root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("reads AGENTS.md, falling back to CLAUDE.md when AGENTS.md is missing or empty", async () => {
  const cases: readonly [Readonly<Record<string, string>>, string | null, string | null][] = [
    [{ "AGENTS.md": "agents\n", "CLAUDE.md": "claude\n" }, "AGENTS.md", "agents\n"],
    [{ "CLAUDE.md": "claude\n" }, "CLAUDE.md", "claude\n"],
    [{ "AGENTS.md": "", "CLAUDE.md": "claude\n" }, "CLAUDE.md", "claude\n"],
    [{}, null, null],
  ];
  for (const [files, name, content] of cases) {
    await withWorkspace(files, async (read, root) => {
      const file = await read();
      assert.deepEqual(file, name === null ? null : { path: join(root, name), content });
    });
  }
});

test("caps a large file in the sandbox and points the model at the rest", async () => {
  await withWorkspace({ "AGENTS.md": "x".repeat(70_000) }, async (read, root) => {
    const file = await read();
    const note = `\n\n[truncated: read ${join(root, "AGENTS.md")} for the rest]`;
    assert.equal(file?.content, `${"x".repeat(64_000)}${note}`);
  });
});
