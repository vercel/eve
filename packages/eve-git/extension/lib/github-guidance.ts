const PUBLISHING = `Load the pr skill before publishing. Create one pull request per request unless the requester asks otherwise.`;

/** Agents without `github` config reach GitHub with their own shell credentials. */
const SHELL_INSTRUCTIONS = `# GitHub

Use the \`gh\` and \`git\` CLIs in \`bash\` for GitHub operations: cloning, fetching, pushing, issues, pull requests, reviews, and CI. They authenticate with the credentials already configured in the shell. Never put credentials in URLs or commands. If access is denied, report it plainly and stop.
`;

const TOKEN_SCOPE = {
  repository: {
    token:
      "Connect mints a GitHub App installation token for the declared repository, or for the owner's installation when you declare only an owner.",
    repository:
      "Set `repository` to the `owner/name` the command acts on, or to an owner for discovery.",
  },
  caller: {
    token:
      "Connect resolves the caller's own GitHub token for each command. It carries the caller's GitHub permissions, so access is limited to what the caller can reach on GitHub.",
    repository:
      "Set `repository` to the `owner/name` the command acts on, or omit it for commands that act on no single repository, such as `gh repo list <owner>`, `gh search repos`, or `gh api user/repos`.",
  },
} as const;

/** Holds only when the Connect-brokered `gh` tool can authenticate, which requires `github` config. */
const connectInstructions = (scope: (typeof TOKEN_SCOPE)[keyof typeof TOKEN_SCOPE]) => `# GitHub

GitHub credentials are not available to ordinary \`bash\`. Use the \`gh\` tool for every authenticated GitHub operation: \`gh\`, \`git\`, and \`gh-signed-commit\` commands. The full \`gh\` and \`git\` CLI surface is available. ${scope.repository} The agent's access policy decides whether each command runs. Authenticated commands run without an approval prompt; describe the intended GitHub-side result accurately in \`description\`. ${scope.token} The sandbox process receives only a placeholder \`GH_TOKEN\`, and the firewall exchanges it on matching GitHub requests. Never put credentials in URLs or commands. If access is denied, report it plainly and stop.

Pass commands as simple argv with ordinary quoting. Do not use environment assignments, pipes, redirects, substitutions, or other shell syntax.

Find the repositories a task needs yourself, even when the requester does not name them or names them loosely. Search with \`gh repo list <owner>\`, \`gh search repos <query>\`, or \`gh search repos --owner <owner> <query>\`, and suggest the closest match when a name does not resolve. Do not ask the requester for an exact \`owner/name\` you can discover, and never default to the current agent's repository. Each command declares its own target, so cross-repository work uses separate commands.

Clone with \`gh repo clone owner/name\`. Use authenticated \`git fetch\`, \`git pull\`, \`git push\`, and \`git ls-remote\` through the \`gh\` tool too. Local \`git status\`, \`diff\`, \`add\`, \`commit\`, and \`rebase\` remain ordinary \`bash\` commands because they need no GitHub credential.

Use GitHub CLI commands through the \`gh\` tool for issues, pull requests, reviews, Actions, CI, authentication status, configuration, aliases, extensions, and API requests. Common commands include \`gh pr create --draft\`, \`gh pr checks\`, \`gh run rerun --failed\`, and \`gh pr review\`, but they are not restrictions.

Repositories that require verified signatures reject ordinary sandbox commits. Stage the intended changes explicitly, run \`gh-signed-commit --repo owner/name --branch <branch> -m <headline>\` through the \`gh\` tool, then create the draft pull request through the same tool.
`;

/** `callerScoped` describes user tokens (`principalType: "user"`) instead of repository-scoped app tokens. */
export function githubInstructions(github: boolean, callerScoped = false): string {
  const guidance = github
    ? connectInstructions(TOKEN_SCOPE[callerScoped ? "caller" : "repository"])
    : SHELL_INSTRUCTIONS;
  return `${guidance}\n${PUBLISHING}\n`;
}

/** `gh-signed-commit` authenticates through the `gh` tool's credential lease. */
const SIGNED_COMMIT = `Stage only the intended changes. Repositories that require verified commits must use:

\`\`\`sh
gh-signed-commit --repo owner/name --branch <branch> --base <base> -m "<headline>" [-b "<body>"]
\`\`\`

The command commits only staged changes and synchronizes the checkout to the signed remote commit. Then write the PR body to a file and create one draft:`;

const PLAIN_COMMIT = `Stage only the intended changes, commit them, and push the branch. Then write the PR body to a file and create one draft:`;

export function prSkillDescription(github: boolean): string {
  return github
    ? "Prepare and publish a draft pull request with a signed commit, motivation-led description, testable hypothesis, and validation evidence."
    : "Prepare and publish a draft pull request with a motivation-led description, testable hypothesis, and validation evidence.";
}

export function prSkillMarkdown(github: boolean): string {
  return `# Publish a proposal

Fetch the current base immediately before publication. Rebase onto it, or replay only the intended diff onto a clean checkout when local commits are unavailable. Stop on conflicts, stale refs, unexpected paths, or unrelated reversions.

${github ? SIGNED_COMMIT : PLAIN_COMMIT}

\`\`\`sh
gh pr create --draft --title "<title>" --body-file <path> --base <base> --head <branch>
\`\`\`

Use a specific title that names the behavior or problem. Never use placeholders such as \`prepare changes\`. Keep secrets, private context, credentials, and requester identity out of public metadata.

Write directly and top-down. Start with impact, then explain the essential decisions and why this shape tests the hypothesis. Prefer simple English and brief context over a wall of generated prose. Include truthful reproduction and validation evidence.

A useful description answers:

1. Why the change is necessary.
2. Why this approach is the smallest sound solution.
3. Which entry points and data flows change.
4. What evidence verifies the expected outcome.

Prefer this shape unless the repository has a required template:

\`\`\`markdown
[One-line summary of what changed and why]

**Why**

[Observed problem, evidence, and impact]

**Approach**

Because [cause], changing [mechanism] should [expected outcome].

**Validation**

[Focused checks and results]

**Relevant context**

[Only the implementation or data-flow details reviewers need]
\`\`\`
`;
}
