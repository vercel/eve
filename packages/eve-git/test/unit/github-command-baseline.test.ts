import assert from "node:assert/strict";
import test from "node:test";

import { githubCommandDenial, parseCommand } from "../../extension/lib/github-shell.ts";
import { MAIN_BASELINE } from "./github-command-baseline.fixture.ts";

const INPUT = {
  description: "Comment on the pull request",
  permissions: [{ provider: "github", repositories: ["vercel/eve"], access: "write" }],
} as const;

const NEWLY_REFUSED = new Set(["chain", "invalid_input", "line_continuation", "git_remote"]);

test("accepts only commands main accepts, with the argv main produces", () => {
  assert.ok(MAIN_BASELINE.some(([, accepted]) => accepted));
  assert.ok(MAIN_BASELINE.some(([, accepted]) => !accepted));
  for (const [command, accepted, argv] of MAIN_BASELINE) {
    const denial = githubCommandDenial({ ...INPUT, command });
    if (!denial) {
      assert.ok(accepted, `main refuses ${JSON.stringify(command)}`);
      assert.deepEqual(parseCommand(command), argv, command);
    } else if (accepted) {
      assert.ok(NEWLY_REFUSED.has(denial.code), `${JSON.stringify(command)}: ${denial.code}`);
      if (denial.code === "chain") assert.match(command, /\n/u, command);
    }
  }
});
