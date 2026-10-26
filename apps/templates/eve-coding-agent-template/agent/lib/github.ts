import type { GitHubLeaseBroker } from "eve/extensions/git";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { VercelSandboxSession } from "eve/sandbox/vercel";

/** Vercel Connect GitHub connector shared by the channel and the `git__gh` tool. */
export const GITHUB_CONNECTOR = process.env.GITHUB_CONNECTOR || "github/coding-agent";

/**
 * Installs one repository-scoped credential lease for a `gh` command, then
 * clears it when called with `null`. All other egress stays open.
 */
export const brokerGitHubLease: GitHubLeaseBroker = async (sandbox, rules) => {
  if (!("setNetworkPolicy" in sandbox)) {
    throw new Error("GitHub credential leases require a sandbox with a mutable network policy.");
  }
  const policy = { allow: { "*": [], ...rules } } as SandboxNetworkPolicy;
  await (sandbox as VercelSandboxSession).setNetworkPolicy(policy);
};
