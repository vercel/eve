import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProjectInstructions,
  formatWorkspaceContext,
} from "../../extension/lib/project-instructions.ts";

test("formats the file as pi's project context", () => {
  assert.equal(
    formatProjectInstructions({ path: "/workspace/AGENTS.md", content: "Run pnpm test." }),
    'Project-specific instructions and guidelines:\n\n<project_instructions path="/workspace/AGENTS.md">\nRun pnpm test.\n</project_instructions>',
  );
});

test("formats working directory with or without project instructions", () => {
  assert.equal(formatWorkspaceContext("/testbed", null), "Current working directory: /testbed");
  assert.equal(
    formatWorkspaceContext("/testbed", { path: "/testbed/AGENTS.md", content: "Run pytest." }),
    'Current working directory: /testbed\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/testbed/AGENTS.md">\nRun pytest.\n</project_instructions>',
  );
});
