import type { GitHubLeaseBroker } from "eve/extensions/git";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import type { VercelSandboxSession } from "eve/sandbox/vercel";

/** Vercel Connect GitHub connector shared by the channel and the `git__gh` tool. */
export const GITHUB_CONNECTOR = process.env.GITHUB_CONNECTOR || "github/coding-agent";

/**
 * Writes the credential rules for every running `gh` command, or clears them
 * when called with `null`. All other egress stays open.
 */
export const brokerGitHubLease: GitHubLeaseBroker = async (sandbox, rules) => {
  if (!("setNetworkPolicy" in sandbox)) {
    throw new Error("GitHub credential leases require a sandbox with a mutable network policy.");
  }
  const policy = { allow: { "*": [], ...rules } } as SandboxNetworkPolicy;
  await (sandbox as VercelSandboxSession).setNetworkPolicy(policy);
};

type GitHubLeaseRules = NonNullable<Parameters<GitHubLeaseBroker>[1]>;

/**
 * Reads back the GitHub rules `brokerGitHubLease` wrote, so overlapping `gh`
 * commands keep each other's rules. The Sandbox API redacts injected header
 * values and returns match values as written.
 */
export const readGitHubLease = async (sandbox: SandboxSession): Promise<GitHubLeaseRules> => {
  if (!("getNetworkPolicy" in sandbox)) {
    throw new Error("GitHub credential leases require a sandbox with a readable network policy.");
  }
  const policy = await (
    sandbox as { getNetworkPolicy(): Promise<SandboxNetworkPolicy> }
  ).getNetworkPolicy();
  if (typeof policy === "string" || Array.isArray(policy.allow)) return {};
  const { "*": _, ...rules } = (policy.allow ?? {}) as Record<string, unknown>;
  return rules as GitHubLeaseRules;
};
