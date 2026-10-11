const PUBLISHING = `Load the pr skill before publishing. Create one pull request per request unless the requester asks otherwise.`;

/** Agents without `github` config reach GitHub with their own shell credentials. */
const SHELL_INSTRUCTIONS = `# GitHub

Use the \`gh\` and \`git\` CLIs in \`bash\` for GitHub operations: cloning, fetching, pushing, issues, pull requests, reviews, and CI. They authenticate with the credentials already configured in the shell. Never put credentials in URLs or commands. If access is denied, report it plainly and stop.
`;

/** Holds only when the Connect-brokered `gh` tool can authenticate, which requires `github` config. */
const CONNECT_INSTRUCTIONS = `# GitHub

GitHub credentials are not available to ordinary \`bash\`. Use the \`gh\` tool for every authenticated GitHub operation. The full \`gh\` CLI surface is available. Declare exactly one repository in the configured organization with write-capable access. Authenticated commands run without an approval prompt; describe the intended GitHub-side result accurately in \`description\`. Connect mints the real token for only the declared repository. The sandbox process receives only a placeholder \`GH_TOKEN\`, and the firewall exchanges it on matching GitHub requests. GitHub rejects access outside the token's server-side repository scope. Never put credentials in URLs or commands. If access is denied, report it plainly and stop.

Pass commands as simple argv with ordinary quoting. Do not use environment assignments, pipes, redirects, substitutions, or other shell syntax. Commands without an explicit repository may use normal \`gh\` context, but their token remains scoped to the declared repository. An explicit \`-R\`, \`--repo\`, \`--repo=\`, or repository argument to \`gh repo clone\`, \`view\`, or \`fork\` must match the declaration.

Determine the repositories needed to complete the task through source discovery and investigation, even when the requester does not name them. Do not ask the requester to enumerate repositories that can be discovered, and never default to the current agent's repository. The agent may select additional repositories as the work reveals them. Each authenticated command declares exactly one target repository and mints a credential lease for that repository at the moment it is needed, so cross-repository work uses separate scoped commands and leases.

Clone with \`gh repo clone owner/name\`. Use authenticated \`git fetch\`, \`git pull\`, \`git push\`, and \`git ls-remote\` through the \`gh\` tool too. Local \`git status\`, \`diff\`, \`add\`, \`commit\`, and \`rebase\` remain ordinary \`bash\` commands because they need no GitHub credential.

Use GitHub CLI commands through the \`gh\` tool for issues, pull requests, reviews, Actions, CI, authentication status, configuration, aliases, extensions, and API requests. Common commands include \`gh pr create --draft\`, \`gh pr checks\`, \`gh run rerun --failed\`, and \`gh pr review\`, but they are not restrictions.

Repositories that require verified signatures reject ordinary sandbox commits. Stage the intended changes explicitly, run \`gh-signed-commit --repo owner/name --branch <branch> -m <headline>\` through the \`gh\` tool, then create the draft pull request through the same tool.
`;

export function githubInstructions(github: boolean): string {
  return `${github ? CONNECT_INSTRUCTIONS : SHELL_INSTRUCTIONS}\n${PUBLISHING}\n`;
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
