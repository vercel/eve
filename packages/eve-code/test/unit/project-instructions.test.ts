import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProjectInstructions,
  readProjectInstructions,
} from "../../extension/lib/project-instructions.ts";

function sandbox(files: Readonly<Record<string, string>>) {
  return {
    resolvePath: (path: string) => `/workspace/${path}`,
    readTextFile: async ({ path }: { path: string }) => files[path] ?? null,
  };
}

test("reads AGENTS.md, falling back to CLAUDE.md when AGENTS.md is missing or blank", async () => {
  const cases: readonly [Readonly<Record<string, string>>, string | null][] = [
    [{ "/workspace/AGENTS.md": "agents", "/workspace/CLAUDE.md": "claude" }, "agents"],
    [{ "/workspace/CLAUDE.md": "claude" }, "claude"],
    [{ "/workspace/AGENTS.md": " \n", "/workspace/CLAUDE.md": "claude" }, "claude"],
    [{}, null],
  ];
  for (const [files, expected] of cases) {
    const file = await readProjectInstructions(sandbox(files));
    assert.equal(file?.content ?? null, expected);
  }
});

test("bounds a large file and points the model at the rest", async () => {
  const file = await readProjectInstructions(
    sandbox({ "/workspace/AGENTS.md": "x".repeat(70_000) }),
  );
  assert.equal(
    file?.content.length,
    64_000 + "\n\n[truncated: read /workspace/AGENTS.md for the rest]".length,
  );
  assert.ok(file?.content.endsWith("[truncated: read /workspace/AGENTS.md for the rest]"));
});

test("formats the file as pi's project context", () => {
  assert.equal(
    formatProjectInstructions({ path: "/workspace/AGENTS.md", content: "Run pnpm test." }),
    'Project-specific instructions and guidelines:\n\n<project_instructions path="/workspace/AGENTS.md">\nRun pnpm test.\n</project_instructions>',
  );
});
