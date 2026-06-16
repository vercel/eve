import type {
  SandboxCreateOptions,
  Sandbox as SdkSandbox,
} from "#compiled/@vercel/sandbox/index.js";

import { buildDockerBaseSetupScript } from "#execution/sandbox/bindings/docker-base-setup.js";

/**
 * Prepares a fresh Vercel sandbox for use by the framework.
 */
export async function ensureVercelSandboxBaseRuntime(sandbox: SdkSandbox): Promise<void> {
  await runSandboxBootstrapStep(sandbox, {
    failureMessage: "Failed to initialize Vercel sandbox base runtime.",
    script: buildDockerBaseSetupScript(),
  });
}

export async function applyInitialVercelNetworkPolicy(
  sandbox: SdkSandbox,
  networkPolicy: SandboxCreateOptions["networkPolicy"],
): Promise<void> {
  if (networkPolicy !== undefined) {
    await sandbox.update({ networkPolicy });
  }
}

async function runSandboxBootstrapStep(
  sandbox: SdkSandbox,
  input: { readonly failureMessage: string; readonly script: string },
): Promise<void> {
  const result = await runBootstrapCommand(sandbox, input.script);
  if (result === null) {
    return;
  }

  const sudoResult = await runBootstrapCommandWithSudo(sandbox, input.script);
  if (sudoResult === null) {
    return;
  }

  const output = [result, sudoResult].filter(Boolean).join("\n");
  throw new Error(`${input.failureMessage}${output ? `\n${output}` : ""}`);
}

async function runBootstrapCommand(sandbox: SdkSandbox, script: string): Promise<string | null> {
  return await readBootstrapFailure(
    await sandbox.runCommand({
      args: ["-lc", script],
      cmd: "bash",
    }),
  );
}

async function runBootstrapCommandWithSudo(
  sandbox: SdkSandbox,
  script: string,
): Promise<string | null> {
  return await readBootstrapFailure(
    await sandbox.runCommand({
      args: ["-n", "bash", "-lc", script],
      cmd: "sudo",
    }),
  );
}

async function readBootstrapFailure(
  result: Awaited<ReturnType<SdkSandbox["runCommand"]>>,
): Promise<string | null> {
  if (result.exitCode === 0) {
    return null;
  }

  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}
