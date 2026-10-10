/** Consumer-facing helpers exported as `eve/extensions/git/sandbox`. */
export {
  executeGitHubShell,
  githubShellApproval,
  type GitHubConfig,
  type GitHubLeaseRule,
  type GitHubShellInput,
  type GitHubShellOutput,
} from "./github-shell.ts";
export { GH_SIGNED_COMMIT_SOURCE, GH_SIGNED_COMMIT_VERSION } from "./signed-commit.ts";
export { GITHUB_TOOLING_PATHS } from "./tooling.ts";
export { defineGhTool, GH_TOOL_DESCRIPTION } from "./gh-tool.ts";
export { githubInstructions, prSkillDescription, prSkillMarkdown } from "./github-guidance.ts";
