import { buildDockerBaseSetupScript } from "#execution/sandbox/bindings/docker-base-setup.js";
import type { VercelSandboxCreateParams } from "#execution/sandbox/bindings/vercel-create-sdk.js";
import type {
  VercelCreateOptions,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

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

export function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    await sandbox.update({ networkPolicy: policy });
  };
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
