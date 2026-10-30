import assert from "node:assert/strict";
import test from "node:test";

import { defineGhTool } from "../../extension/lib/gh-tool.ts";

test("gh labels activity with the expected GitHub-side result", () => {
  const tool = defineGhTool(() => undefined);
  const label = tool.label as { start: (input: unknown) => string };
  assert.equal(
    label.start({
      command: "gh -R vercel/eve pr view 123 --comments",
      description: "Read review comments on PR 123",
      repository: "vercel/eve",
    }),
    "Read review comments on PR 123",
  );
});
