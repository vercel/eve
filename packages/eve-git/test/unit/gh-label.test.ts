import assert from "node:assert/strict";
import test from "node:test";

import { defineGhTool } from "../../extension/lib/gh-tool.ts";

test("gh tool calls read as the command they run", () => {
  const tool = defineGhTool(() => undefined);
  const input = {
    command: "gh pr create --fill",
    description: "Open the pull request",
    repository: "vercel/eve",
  };
  assert.equal(tool.label?.start?.(input), "Run gh pr create --fill");
});
