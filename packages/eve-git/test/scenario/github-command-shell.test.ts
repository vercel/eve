import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { githubShellApproval, parseCommand } from "../../extension/lib/github-shell.ts";
import { shellQuote } from "../../extension/lib/shell.ts";

const INPUT = {
  description: "Comment on the pull request",
  permissions: [{ provider: "github", repositories: ["vercel/eve"], access: "write" }],
} as const;

/** Runs `script` in an empty-environment temporary directory that holds `a.md`, `b.md`, and `x`. */
function shellRun(argv: readonly string[], script: string) {
  const cwd = mkdtempSync(join(tmpdir(), "eve-gh-parity-"));
  try {
    for (const file of ["a.md", "b.md", "x"]) writeFileSync(join(cwd, file), "");
    const result = spawnSync(argv[0]!, [...argv.slice(1), script], {
      cwd,
      encoding: "utf8",
      env: { HOME: cwd, PATH: "/usr/bin:/bin" },
    });
    return { status: result.status, argv: result.stdout.split("\0").slice(0, -1) };
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
}

/** The argv bash passes to `gh` for `command`, with default options. */
function bashRun(command: string) {
  return shellRun(["bash", "-c"], `gh() { printf '%s\\0' gh "$@"; }\n${command}`);
}

function bashArgv(command: string): string[] {
  const result = bashRun(command);
  assert.equal(result.status, 0, `bash exited ${result.status} for ${JSON.stringify(command)}`);
  return result.argv;
}

type Expectation = "same" | "differs" | "refused";

/**
 * Each token in a word (`x<token>.`), alone, and inside double quotes. `same`: accepted with
 * bash's argv. `differs`: accepted as literal text that bash interprets. `refused`: denied, and
 * bash interprets it. Single quotes keep every token without an apostrophe literal in both.
 */
const TOKENS: readonly (readonly [string, Expectation, Expectation, Expectation])[] = [
  ["|", "refused", "refused", "same"],
  ["|&", "refused", "refused", "same"],
  [";", "refused", "refused", "same"],
  ["&&", "refused", "refused", "same"],
  ["||", "refused", "refused", "same"],
  ["&", "refused", "refused", "same"],
  ["\n", "refused", "refused", "same"],
  ["<", "refused", "refused", "same"],
  [">", "refused", "refused", "same"],
  [">>", "refused", "refused", "same"],
  ["&>", "refused", "refused", "same"],
  ["<<", "refused", "refused", "same"],
  ["<<<", "refused", "refused", "same"],
  ["$(id)", "refused", "refused", "refused"],
  ["$((1+1))", "refused", "refused", "refused"],
  ["$[1+1]", "refused", "refused", "refused"],
  ["<(id)", "refused", "refused", "same"],
  [">(id)", "refused", "refused", "same"],
  ["$'a'", "refused", "refused", "same"],
  ["`id`", "refused", "refused", "differs"],
  ["${HOME}", "refused", "refused", "refused"],
  ["$HOME", "refused", "refused", "refused"],
  ["$1", "refused", "refused", "refused"],
  ["$?", "refused", "refused", "refused"],
  ["$$", "refused", "refused", "refused"],
  ["$", "same", "same", "same"],
  ["5$", "same", "same", "same"],
  ["{a,b}", "refused", "refused", "same"],
  ["{1..3}", "refused", "refused", "same"],
  ["{a..c}", "refused", "refused", "same"],
  ["{+1..3}", "refused", "refused", "same"],
  ["{owner}", "same", "same", "same"],
  ["{}", "same", "same", "same"],
  ["{..}", "same", "same", "same"],
  ["{a..}", "same", "same", "same"],
  ["(", "differs", "differs", "same"],
  [")", "differs", "differs", "same"],
  ["#", "same", "differs", "same"],
  ["~", "same", "differs", "same"],
  ["=~/n", "differs", "same", "same"],
  ["*", "same", "differs", "same"],
  ["?", "same", "differs", "same"],
  ["[ax]", "same", "differs", "same"],
];

function corpus() {
  return TOKENS.flatMap(([token, word, alone, double]) => [
    { command: `gh pr comment 1 --body x${token}. end`, literal: `x${token}.`, expected: word },
    { command: `gh pr comment 1 --body ${token} end`, literal: token, expected: alone },
    {
      command: `gh pr comment 1 --body "x ${token} y" end`,
      literal: `x ${token} y`,
      expected: double,
    },
    ...(token.includes("'")
      ? []
      : [
          {
            command: `gh pr comment 1 --body 'x ${token} y' end`,
            literal: `x ${token} y`,
            expected: "same" as const,
          },
        ]),
  ]);
}

test("each token parses as the table states, checked against bash", () => {
  for (const { command, literal, expected } of corpus()) {
    const text = ["gh", "pr", "comment", "1", "--body", literal, "end"];
    const approval = githubShellApproval({ ...INPUT, command });
    if (expected === "refused") {
      assert.equal(typeof approval, "object", `${JSON.stringify(command)} is refused`);
      const bash = bashRun(command);
      assert.ok(
        bash.status !== 0 || JSON.stringify(bash.argv) !== JSON.stringify(text),
        `bash interprets ${JSON.stringify(command)}`,
      );
      continue;
    }
    assert.equal(approval, "not-applicable", `${JSON.stringify(command)} is accepted`);
    assert.deepEqual(parseCommand(command), text, command);
    if (expected === "same") {
      assert.deepEqual(bashArgv(command), text, command);
    } else {
      const bash = bashRun(command);
      assert.ok(
        bash.status !== 0 || JSON.stringify(bash.argv) !== JSON.stringify(text),
        `bash interprets ${JSON.stringify(command)}`,
      );
    }
  }
});

test("quoting, escapes, and line continuations parse as bash reads them", () => {
  for (const command of [
    'gh pr view "{a,b}" \\{c,d}',
    "gh pr comment 1 --body \\$HOME",
    "gh pr create \\\n  --title Fix",
    'gh pr comment 1 --body "one \\\ntwo"',
    "gh pr comment 1 --body 'one \\\ntwo'",
    'gh pr comment 1 --body "C:\\path \\$ \\" \\\\ \\`"',
    "gh pr comment 1 --body it\\'s",
    "gh pr comment 1 --body a\u00a0b\rc",
  ]) {
    assert.deepEqual(parseCommand(command), bashArgv(command), command);
  }
});

test("single-quoted argv survives sh and bash -lc unchanged, and NUL never reaches it", () => {
  const argv = [
    "$(id)",
    "`id`",
    "a;b && c | d > e",
    "line\nbreak",
    `'"'"'`,
    "it's",
    "${HOME} $HOME ~ * ?",
    "",
    " padded ",
    "\\",
  ];
  const script = `printf '%s\\0' ${argv.map(shellQuote).join(" ")}`;
  for (const shell of [
    ["sh", "-c"],
    ["bash", "-lc"],
  ]) {
    const result = shellRun(shell, script);
    assert.equal(result.status, 0, shell.join(" "));
    assert.deepEqual(result.argv, argv, shell.join(" "));
  }
  assert.throws(() => parseCommand("gh pr comment 1 --body 'a\0b'"), /NUL character/u);
});
