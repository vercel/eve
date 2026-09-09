import { defineSandbox, type SandboxSession } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

const REPOSITORY_DIRECTORY = "/workspace/ms";

export default defineSandbox({
  backend: vercel({ ports: [4319, 4320, 4321, 4322] }),
  async bootstrap({ use }) {
    const sandbox = await use();
    await runSandboxCommand({
      command: "git clone --depth 1 --branch main https://github.com/vercel/ms.git /workspace/ms",
      sandbox,
    });
    await installDependencies({ sandbox });
  },
  async onSession({ use }) {
    const sandbox = await use();
    await runSandboxCommand({
      command: "git pull --ff-only",
      sandbox,
      workingDirectory: REPOSITORY_DIRECTORY,
    });
    await installDependencies({ sandbox });
  },
});

async function installDependencies(input: { readonly sandbox: SandboxSession }): Promise<void> {
  await runSandboxCommand({
    command: "pnpm install --frozen-lockfile",
    sandbox: input.sandbox,
    workingDirectory: REPOSITORY_DIRECTORY,
  });
}

async function runSandboxCommand(input: {
  readonly command: string;
  readonly sandbox: SandboxSession;
  readonly workingDirectory?: string;
}): Promise<void> {
  const result = await input.sandbox.run({
    command: input.command,
    workingDirectory: input.workingDirectory,
  });
  if (result.exitCode === 0) {
    return;
  }

  const output = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    `Sandbox command failed with exit code ${result.exitCode}: ${input.command}${output === "" ? "" : `\n${output}`}`,
  );
}
