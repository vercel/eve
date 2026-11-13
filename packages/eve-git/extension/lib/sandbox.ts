/** Consumer-facing helpers exported as `eve/extensions/git/sandbox`. */
export {
  executeGitHubShell,
  GitHubCommandInputError,
  githubShellApproval,
  isGitHubCommandInputError,
  type GitHubCoAuthor,
  type GitHubConfig,
  type GitHubLeaseRule,
  type GitHubShellInput,
  type GitHubShellOutput,
} from "./github-shell.ts";
export { DEFAULT_EVE_GIT_SANDBOX_IMAGE } from "eve/sandbox/docker";
export { VERCEL_EVE_GIT_SANDBOX_IMAGE } from "eve/sandbox/vercel";
