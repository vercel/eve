import { buildDockerBaseSetupScript } from "#execution/sandbox/bindings/docker-base-setup.js";
import type { VercelSandboxCreateParams } from "#execution/sandbox/bindings/vercel-create-sdk.js";
import type {
  VercelCreateOptions,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxNetworkPolicyBinding } from "#execution/sandbox/network-policy.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

/** What the Vercel SDK returns in place of every brokered header value. */
const VERCEL_REDACTED_HEADER = "<redacted>";

/**
 * Prepares a fresh Vercel sandbox for use by the framework.
 */
export async function ensureVercelSandboxBaseRuntime(sandbox: VercelSandbox): Promise<void> {
  await runSandboxInitializationStep(sandbox, {
    failureMessage: "Failed to initialize Vercel sandbox base runtime.",
    script: buildDockerBaseSetupScript(),
  });
}

export async function applyInitialVercelNetworkPolicy(
  sandbox: VercelSandbox,
  networkPolicy: VercelCreateOptions["networkPolicy"],
): Promise<void> {
  if (networkPolicy !== undefined) {
    await sandbox.update({ networkPolicy });
  }
}

export function withBaseSetupNetworkPolicy(
  createOptions: VercelSandboxCreateParams,
): VercelSandboxCreateParams {
  return { ...createOptions, networkPolicy: "allow-all" };
}

/**
 * Binds a session's policy to `sandbox.update`. Vercel keeps no copy of the
 * user's policy that eve can read back in full, so a fresh handle recovers it
 * from the live policy: see {@link recoverVercelUserNetworkPolicy}.
 */
export function createVercelNetworkPolicyBinding(
  sandbox: VercelSandbox,
): SandboxNetworkPolicyBinding {
  return {
    async apply(policy) {
      await sandbox.update({ networkPolicy: policy });
    },
    async readUserPolicy(credentialHosts) {
      return recoverVercelUserNetworkPolicy(sandbox.networkPolicy, credentialHosts);
    },
  };
}

/**
 * Recovers the user's policy from the live one. The live host list and subnets
 * are exact, because eve never adds hosts. Rules on `credentialHosts` are
 * treated as eve's leftovers from an interrupted step and dropped. The SDK
 * redacts header values and nothing records which values are live, so header
 * rules on any other host make the policy unrecoverable.
 */
export function recoverVercelUserNetworkPolicy(
  live: SandboxNetworkPolicy | undefined,
  credentialHosts: readonly string[],
): SandboxNetworkPolicy {
  const current = withoutHostRules(live ?? "allow-all", credentialHosts);
  if (!JSON.stringify(current).includes(JSON.stringify(VERCEL_REDACTED_HEADER))) return current;
  throw new Error(
    "The sandbox network policy has header rules, and Vercel does not return their values, so eve cannot attach credentials without dropping them.",
  );
}

function withoutHostRules(
  policy: SandboxNetworkPolicy,
  hosts: readonly string[],
): SandboxNetworkPolicy {
  if (typeof policy === "string" || policy.allow === undefined || Array.isArray(policy.allow)) {
    return policy;
  }
  const allow = { ...policy.allow };
  for (const host of hosts) if (host in allow) allow[host] = [];
  return { ...policy, allow };
}

async function runSandboxInitializationStep(
  sandbox: VercelSandbox,
  input: { readonly failureMessage: string; readonly script: string },
): Promise<void> {
  const result = await runInitializationCommand(sandbox, input.script);
  if (result === null) {
    return;
  }

  const sudoResult = await runInitializationCommandWithSudo(sandbox, input.script);
  if (sudoResult === null) {
    return;
  }

  const output = [result, sudoResult].filter(Boolean).join("\n");
  throw new Error(`${input.failureMessage}${output ? `\n${output}` : ""}`);
}

async function runInitializationCommand(
  sandbox: VercelSandbox,
  script: string,
): Promise<string | null> {
  return await readInitializationFailure(
    await sandbox.runCommand({
      args: ["-lc", script],
      cmd: "bash",
    }),
  );
}

async function runInitializationCommandWithSudo(
  sandbox: VercelSandbox,
  script: string,
): Promise<string | null> {
  return await readInitializationFailure(
    await sandbox.runCommand({
      args: ["-n", "bash", "-lc", script],
      cmd: "sudo",
    }),
  );
}

async function readInitializationFailure(
  result: Awaited<ReturnType<VercelSandbox["runCommand"]>>,
): Promise<string | null> {
  if (result.exitCode === 0) {
    return null;
  }

  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}
