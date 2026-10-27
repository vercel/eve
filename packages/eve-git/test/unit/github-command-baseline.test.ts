import assert from "node:assert/strict";
import test from "node:test";

import { githubCommandDenial, parseCommand } from "../../extension/lib/github-shell.ts";
import { mainAcceptedArgv } from "./main-github-command.ts";

const INPUT = {
  description: "Comment on the pull request",
  permissions: [{ provider: "github", repositories: ["vercel/eve"], access: "write" }],
} as const;

const TOKENS = [
  "|",
  "|&",
  ";",
  "&&",
  "||",
  "&",
  "\n",
  "<",
  ">",
  ">>",
  "&>",
  "2>&1",
  "<<",
  "<<<",
  "$(id)",
  "$((1+1))",
  "$[1+1]",
  "<(id)",
  ">(id)",
  "$'a'",
  '$"a"',
  "`id`",
  "${HOME}",
  "$HOME",
  "$1",
  "$?",
  "$$",
  "$",
  "5$",
  "{a,b}",
  "{1..3}",
  "{+1..3}",
  "{owner}",
  "{}",
  "{..}",
  "(",
  ")",
  "()",
  "#",
  "~",
  "=~/n",
  "*",
  "?",
  "[ax]",
  "\\$",
  "\\\\",
  "\\'",
  '\\"',
  "\\ ",
  "\\\n",
  "\\(",
  " ",
  "\r",
  "\t",
  "x=y",
  "--flag=value",
  "-",
  "--",
];

/** Each token in a word, alone, inside double quotes, and inside single quotes. */
function commands(): string[] {
  const generated = TOKENS.flatMap((token) => [
    `gh pr comment 1 --body x${token}. end`,
    `gh pr comment 1 --body ${token} end`,
    `gh pr comment 1 --body "x ${token} y" end`,
    `gh pr comment 1 --body 'x ${token} y' end`,
  ]);
  return [
    ...generated,
    "gh",
    "gh api 'repos/{owner}/{repo}/pulls' --jq '.[] | .title'",
    "gh pr create --title Fix --body-file /tmp/body.md",
    "gh pr create --body-file - <<'EOF'\nIt's done\nEOF",
    "gh pr comment 1 --body 'It's done.\nNext'",
    "gh pr comment 1 --body 'unterminated",
    'gh pr comment 1 --body "unterminated',
    "gh pr view 1 \\",
    "gh pr view 1\ngh pr view 2",
    "gh pr comment 1 --body a\0b",
    "git push origin main",
    "git push -u origin main",
    "git push origin main -u",
    "git push upstream main",
    "git fetch",
    "git -C repo push origin main",
    "git commit -m fix",
    "gh-signed-commit --repo vercel/eve --branch fix -m Fix",
    "GH_TOKEN=x gh auth status",
    "env GH_TOKEN=x gh auth status",
    "cd repo && git push origin main",
    "cd repo",
    "bash -lc gh",
  ];
}

const NEWLY_REFUSED = new Set(["chain", "invalid_input", "line_continuation", "git_remote"]);

test("accepts only commands main accepts, with the argv main produces", () => {
  let acceptedByMain = 0;
  let refusedByMain = 0;
  for (const command of commands()) {
    const input = { ...INPUT, command };
    const before = mainAcceptedArgv(input);
    const denial = githubCommandDenial(input);
    if (before) acceptedByMain += 1;
    else refusedByMain += 1;
    if (!denial) {
      assert.ok(before, `main refuses ${JSON.stringify(command)}`);
      assert.deepEqual(parseCommand(command), before, command);
    } else if (before) {
      assert.ok(NEWLY_REFUSED.has(denial.code), `${JSON.stringify(command)}: ${denial.code}`);
      if (denial.code === "chain") assert.match(command, /\n/u, command);
    }
  }
  assert.ok(acceptedByMain > 0 && refusedByMain > 0);
});
