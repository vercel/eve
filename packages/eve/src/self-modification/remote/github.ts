import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import type { GitHubLeaseBroker } from "eve/extensions/code";

import type { ResolvedDeployedSelfModificationConfig } from "./config-schema.js";

type NetworkPolicySandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};

function hasMutableNetworkPolicy(sandbox: SandboxSession): sandbox is NetworkPolicySandboxSession {
  return "setNetworkPolicy" in sandbox;
}

/** Leases GitHub credentials through the firewall; the checkout sandbox otherwise allows all egress. */
export const brokerGitHubLease: GitHubLeaseBroker = async (sandbox, rules) => {
  if (!hasMutableNetworkPolicy(sandbox)) {
    throw new Error("Deployed self-modification requires a sandbox with mutable network policy.");
  }
  await sandbox.setNetworkPolicy(rules === null ? "allow-all" : { allow: { "*": [], ...rules } });
};

export function deployedGitHubConfig(config: ResolvedDeployedSelfModificationConfig) {
  return {
    broker: brokerGitHubLease,
    connector: config.github.connector,
    org: config.github.repository.slice(0, config.github.repository.indexOf("/")),
  };
}
