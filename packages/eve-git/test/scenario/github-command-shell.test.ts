import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { githubShellApproval, parseCommand } from "../../extension/lib/github-shell.ts";
import { shellQuote } from "../../extension/lib/shell.ts";

const INPUT = {
  description: "Comment on the pull request",
  permissions: [{ provider: "github", repositories: ["vercel/eve"], access: "write" }],
} as const;

/** The argv a shell produces for `script`, run with default options in an empty directory. */
function shellArgv(shell: string, script: string): string[] {
  const cwd = mkdtempSync(join(tmpdir(), "eve-gh-parity-"));
  try {
    const result = spawnSync(shell, ["-c", script], {
      cwd,
      encoding: "utf8",
      env: { HOME: cwd, PATH: "/usr/bin:/bin" },
    });
    return result.stdout.split("\0").slice(0, -1);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
}

const bashArgv = (command: string) => shellArgv("bash", `printf '%s\\0' ${command}`);

test("accepted commands parse to the argv bash produces", () => {
  for (const command of [
    "gh api repos/{owner}/{repo}/pulls",
    "gh api graphql -f query={}",
    'gh pr view "{a,b}" \\{c,d} {x}',
    'gh pr comment 1 --body "for 5$ or US$, $ 1"',
    "gh pr comment 1 --body '$(date) `id` ${HOME} $USER'",
    "gh pr comment 1 --body \\$HOME",
    "gh pr create \\\n  --title Fix",
    'gh pr comment 1 --body "C:\\path \\$ \\" \\\\ \\`"',
    'gh pr comment 1 --body "one\ntwo"',
    "gh pr comment 1 --body it\\'s",
  ]) {
    assert.deepEqual(parseCommand(command), bashArgv(command), command);
  }
});

test("accepted commands diverge from bash only where the tool sends text bash interprets", () => {
  for (const [command, bash] of [
    ['gh pr comment 1 --body "Run `printf ok`"', ["gh", "pr", "comment", "1", "--body", "Run ok"]],
    ["gh pr comment 1 --body Fix(parse)", []],
    ["gh issue view #12", ["gh", "issue", "view"]],
  ] as const) {
    assert.equal(githubShellApproval({ ...INPUT, command }), "not-applicable", command);
    assert.deepEqual(bashArgv(command), bash, command);
  }
  const home = parseCommand("gh pr comment 1 --body-file ~/notes.md");
  assert.equal(home.at(-1), "~/notes.md");
});

test("refused commands carry syntax that changes the argv bash produces", () => {
  for (const [command, literal] of [
    ["gh pr view 1 | head", ["gh", "pr", "view", "1", "|", "head"]],
    ["gh pr view 1 && gh pr view 2", ["gh", "pr", "view", "1", "&&", "gh", "pr", "view", "2"]],
    ["gh pr view 1; gh pr view 2", ["gh", "pr", "view", "1;", "gh", "pr", "view", "2"]],
    ["gh pr view 1\ngh pr view 2", ["gh", "pr", "view", "1", "gh", "pr", "view", "2"]],
    ["gh pr view 1 > out", ["gh", "pr", "view", "1", ">", "out"]],
    ["gh pr view $(printf 2)", ["gh", "pr", "view", "$(printf", "2)"]],
    ["gh pr view `printf 2`", ["gh", "pr", "view", "`printf", "2`"]],
    ['gh pr view "${PR}"', ["gh", "pr", "view", "${PR}"]],
    ["gh pr view $PR", ["gh", "pr", "view", "$PR"]],
    ["gh pr view {1,2}", ["gh", "pr", "view", "{1,2}"]],
    ["gh pr view pr-{1..3}", ["gh", "pr", "view", "pr-{1..3}"]],
    ["gh pr comment 1 --body $'a\\nb'", ["gh", "pr", "comment", "1", "--body", "$a\\nb"]],
  ] as const) {
    const decision = githubShellApproval({ ...INPUT, command });
    assert.ok(typeof decision === "object" && decision.type === "denied", command);
    assert.notDeepEqual(bashArgv(command), literal, command);
  }
});

test("single-quoted argv survives sh unchanged, and NUL never reaches it", () => {
  const argv = [
    "$(id)",
    "`id`",
    "a;b && c | d > e",
    "line\nbreak",
    `'"'"'`,
    "it's",
    "${HOME} $HOME ~ *",
    "",
    " padded ",
    "\\",
  ];
  assert.deepEqual(shellArgv("sh", `printf '%s\\0' ${argv.map(shellQuote).join(" ")}`), argv);
  assert.throws(() => parseCommand("gh pr comment 1 --body 'a\0b'"), /NUL character/u);
});
