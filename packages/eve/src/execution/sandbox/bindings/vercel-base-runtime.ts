import { buildDockerBaseSetupScript } from "#execution/sandbox/bindings/docker-base-setup.js";
import type {
  VercelCreateOptions,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

/**
 * Prepares a fresh Vercel sandbox for use by the framework.
 */
export async function ensureVercelSandboxBaseRuntime(sandbox: VercelSandbox): Promise<void> {
  await runSandboxBootstrapStep(sandbox, {
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

async function runSandboxBootstrapStep(
  sandbox: VercelSandbox,
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

async function runBootstrapCommand(sandbox: VercelSandbox, script: string): Promise<string | null> {
  return await readBootstrapFailure(
    await sandbox.runCommand({
      args: ["-lc", script],
      cmd: "bash",
    }),
  );
}

async function runBootstrapCommandWithSudo(
  sandbox: VercelSandbox,
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
  result: Awaited<ReturnType<VercelSandbox["runCommand"]>>,
): Promise<string | null> {
  if (result.exitCode === 0) {
    return null;
  }

  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}
