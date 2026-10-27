import assert from "node:assert/strict";
import test from "node:test";

import {
  githubCommandDenial,
  githubShellApproval,
  parseCommand,
  type GitHubShellInput,
} from "../../extension/lib/github-shell.ts";

const READ: GitHubShellInput = {
  command: "gh pr view 2583 --repo vercel/internal-agents",
  description: "Read PR 2583",
  permissions: [{ provider: "github", repositories: ["vercel/internal-agents"], access: "write" }],
};

const WRITE: GitHubShellInput = {
  command: "git push origin HEAD:refs/heads/rui/my-branch",
  description: "Update the existing PR branch",
  permissions: [{ provider: "github", repositories: ["vercel/internal-agents"], access: "write" }],
  workingDirectory: "/workspace/internal-agents",
};

test("parses simple argv quoting without enabling a shell language", () => {
  for (const [command, argv] of [
    [`gh pr comment 1 --body "it's ready"`, ["gh", "pr", "comment", "1", "--body", "it's ready"]],
    [
      "gh api 'repos/{owner}/{repo}/pulls' --jq '.[] | .title'",
      ["gh", "api", "repos/{owner}/{repo}/pulls", "--jq", ".[] | .title"],
    ],
    ['gh api "repos/{owner}/{repo}"', ["gh", "api", "repos/{owner}/{repo}"]],
    [
      'gh pr comment 1 --body "Fix (all tiers)"',
      ["gh", "pr", "comment", "1", "--body", "Fix (all tiers)"],
    ],
    [
      "gh pr comment 1 --body 'Run `pnpm test` for 5$ in {a,b}'",
      ["gh", "pr", "comment", "1", "--body", "Run `pnpm test` for 5$ in {a,b}"],
    ],
    ["gh pr comment 1 --body \\$HOME", ["gh", "pr", "comment", "1", "--body", "$HOME"]],
  ] as const) {
    assert.deepEqual(parseCommand(command), argv, command);
    assert.equal(githubShellApproval({ ...READ, command }), "not-applicable", command);
  }
});

test("names the refused syntax, its fix, and a stable denial code", () => {
  for (const [command, code, reason] of [
    ["gh pr view 1 | head", "pipe", /"\|" cannot pipe output\. Filter it with --jq/u],
    ["gh pr view 1 && gh pr view 2", "chain", /"&&" cannot chain commands\. Send each command/u],
    ["gh pr view 1; env", "chain", /";" cannot chain commands/u],
    ["gh pr view 1\ngh pr view 2", "chain", /"\\n" cannot chain commands/u],
    ["gh pr create \\\n  --title Fix", "line_continuation", /end of a line cannot continue it/u],
    [
      'gh pr comment 1 --body "one \\\ntwo"',
      "line_continuation",
      /Put the whole command on one line/u,
    ],
    ["gh pr view 1 > out", "redirect", /">" cannot redirect/u],
    ["gh pr create --body-file - <<EOF", "heredoc", /"<<" cannot start a heredoc.*--body-file/u],
    [
      "gh pr create --body-file - <<'EOF'\nIt's done\nEOF",
      "heredoc",
      /"<<" cannot start a heredoc/u,
    ],
    [
      'gh pr comment 1 --body "$(cat notes.md)"',
      "substitution",
      /"\$\(" is not expanded.*--body-file/u,
    ],
    [
      "gh pr view $((1 + 1))",
      "substitution",
      /"\$\(\(" is not evaluated\. Write the computed value/u,
    ],
    ["gh pr comment 1 --body $'it\\'s'", "substitution", /"\$'" quoting is not interpreted/u],
    ['gh pr comment 1 --body "Run `id`"', "substitution", /"`" must be in single quotes/u],
    ['gh pr comment 1 --body "${BODY}"', "variable", /"\$\{" is not expanded/u],
    ["gh pr view $PR_NUMBER", "variable", /"\$PR_NUMBER" is not expanded\..*write \\\$PR_NUMBER/u],
    ['gh pr comment 1 --body "costs 5$"', "variable", /"\$" must be in single quotes/u],
    [
      "gh api repos/{owner}/{repo}",
      "brace_expansion",
      /"\{" must be quoted\. Quote literal braces/u,
    ],
    ["gh pr view {1,2}", "brace_expansion", /"\{" must be quoted/u],
    ["gh pr comment 1 --body Fix(parse)", "subshell", /"\(" must be quoted/u],
    ["GH_TOKEN=stolen gh auth status", "env_assignment", /"GH_TOKEN=" cannot set the environment/u],
    ["env GH_TOKEN=stolen gh auth status", "env_assignment", /"env" cannot set the environment/u],
    [
      "cd internal-agents && git push origin main",
      "cd",
      /Set the workingDirectory parameter to "internal-agents"/u,
    ],
    ["bash -lc gh", "program", /"bash" is not a GitHub command/u],
    ["gh", "gh_subcommand", /Name a gh subcommand/u],
    [
      "git -C internal-agents push origin main",
      "git_option",
      /"-C" is not a subcommand\. Set the workingDirectory parameter to "internal-agents"/u,
    ],
    [
      "git -c core.pager=cat push origin main",
      "git_option",
      /"-c" is not a subcommand\. Set .*git config/u,
    ],
    ["git --no-pager push origin main", "git_option", /never pages output/u],
    ["git commit -m fix", "git_subcommand", /"git commit" is not an authenticated git command/u],
    ["git push -u origin main", "git_remote", /Put "-u" after the remote and refs/u],
    ["git push upstream main", "git_remote", /runs only against origin/u],
    [
      "gh pr comment 1 --body 'it's ready'",
      "unterminated_quote",
      /unterminated ' quote near .*An apostrophe ends single-quoted text/u,
    ],
    [
      "gh pr comment 1 --body 'It's done.\nNext'",
      "unterminated_quote",
      /unterminated ' quote near .*An apostrophe ends single-quoted text/u,
    ],
    ["gh pr comment 1 --body a\0b", "invalid_input", /NUL character/u],
  ] as const) {
    const denial = githubCommandDenial({ ...WRITE, command });
    assert.ok(denial, command);
    assert.equal(denial.code, code, command);
    assert.match(denial.reason, reason, command);
    assert.doesNotMatch(denial.reason, /stolen/u, command);
    assert.deepEqual(githubShellApproval({ ...WRITE, command }), {
      type: "denied",
      reason: denial.reason,
    });
  }
});

test("approves the full syntactically valid gh surface", () => {
  for (const command of [
    "gh api repos/vercel/internal-agents",
    "gh auth token",
    "gh auth status",
    "gh alias set pwn '!env'",
    "gh extension exec x",
    "gh repo view vercel/internal-agents --web",
    "gh pr view 2583 --repo vercel/internal-agents --browser",
  ]) {
    assert.equal(githubShellApproval({ ...READ, command }), "not-applicable", command);
  }
});

test("fails closed on invalid permissions and descriptions", () => {
  const readPush = {
    ...WRITE,
    permissions: [{ ...WRITE.permissions[0], access: "read" as const }] as const,
  };
  // @ts-expect-error Exercise runtime rejection of unsupported read-only permissions.
  assert.deepEqual(githubShellApproval(readPush), {
    type: "denied",
    reason: "GitHub App commands require explicit write-capable access.",
  });
  assert.deepEqual(githubShellApproval({ ...WRITE, description: " " }), {
    type: "denied",
    reason: "description must describe the intended result.",
  });
});
