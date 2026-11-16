import githubExtension from "@github-tools/eve-extension";

/**
 * GitHub tool set for reading and triaging issues, mounted as the `github` extension.
 *
 * @remarks
 * Mounts the GitHub Tools eve extension with the `maintainer` preset via Vercel Connect. The
 * mount file's name is the namespace, so the model sees the tools as `github__<tool>` (for
 * example `github__listIssues`). Scopes are derived from the preset, and tokens are minted inside
 * each tool call for the GitHub App installation that owns the call's repository, so nothing
 * authenticates at import or build time. The connector UID comes from the `GITHUB_CONNECTOR`
 * environment variable, the same one the GitHub channel reads; the fallback here is this
 * project's own connector UID.
 *
 * The extension replaces the deprecated `connectGithubTools` one-liner from
 * `@github-tools/sdk/connect/eve`, whose tool callbacks have no durable descriptor: eve 0.83
 * skips that whole tool set at runtime.
 *
 * Issue-conversation writes (comments, issue create/close, labels) run without approval
 * for authorized maintainer workflows. Inbound authorization is enforced by the channels,
 * not by the model's task prompt. Higher-impact writes (merging PRs, pushing files, repo
 * creation) keep the extension's approval-by-default.
 */
export default githubExtension({
  connector: process.env.GITHUB_CONNECTOR ?? "github/kody-agent",
  preset: "maintainer",
  requireApproval: {
    addIssueComment: "never",
    addLabels: "never",
    closeIssue: "never",
    createIssue: "never",
    removeLabel: "never",
  },
});
