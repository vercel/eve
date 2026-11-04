import assert from "node:assert/strict";
import test from "node:test";

import { formatProjectInstructions } from "../../extension/lib/project-instructions.ts";

test("formats the file as pi's project context", () => {
  assert.equal(
    formatProjectInstructions({ path: "/workspace/AGENTS.md", content: "Run pnpm test." }),
    'Project-specific instructions and guidelines:\n\n<project_instructions path="/workspace/AGENTS.md">\nRun pnpm test.\n</project_instructions>',
  );
});
