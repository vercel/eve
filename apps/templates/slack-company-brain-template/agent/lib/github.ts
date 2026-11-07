import type { GitHubLeaseBroker } from "eve/extensions/git";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { VercelSandboxSession } from "eve/sandbox/vercel";

/** Vercel Connect GitHub connector that mints tokens for the `git__gh` tool. */
export const GITHUB_CONNECTOR = process.env.GITHUB_CONNECTOR || "github/company-brain";

/** Organization or user whose repositories the agent may access. Unset disables GitHub access. */
export const GITHUB_ORG = process.env.GITHUB_ORG?.trim() || undefined;

/**
 * Installs one repository-scoped credential lease for a `gh` command, then
 * clears it when called with `null`. The sandbox only ever sees a placeholder
 * token; the firewall swaps in the real one. All other egress stays open.
 */
export const brokerGitHubLease: GitHubLeaseBroker = async (sandbox, rules) => {
  if (!("setNetworkPolicy" in sandbox)) {
    throw new Error("GitHub credential leases require a sandbox with a mutable network policy.");
  }
  const policy = { allow: { "*": [], ...rules } } as SandboxNetworkPolicy;
  await (sandbox as VercelSandboxSession).setNetworkPolicy(policy);
};
