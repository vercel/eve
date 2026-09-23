/** Consumer-facing helpers exported as `eve/extensions/code/sandbox`. */
import type { SandboxSession } from "eve/sandbox";

import { commandFailureDetail } from "./command-failure.ts";
import {
  DIAGNOSTICS_WORKER_SOURCE,
  GH_SIGNED_COMMIT_SOURCE,
  GH_SIGNED_COMMIT_VERSION,
  ghWrapperSource,
  toolingPaths,
  TYPESCRIPT_VERSION,
  typescriptInstallCommand,
  vercelWrapperSource,
} from "./tooling.ts";

type ToolingSandbox = Pick<SandboxSession, "resolvePath" | "run" | "writeTextFile">;

/** Include in the consumer's sandbox `revalidationKey` so cached templates rebuild when the tooling changes. */
export const CODE_TOOLING_REVALIDATION_KEY = `eve-code-tooling:3:${GH_SIGNED_COMMIT_VERSION}:${TYPESCRIPT_VERSION}`;

/** Install CLI wrappers, signed commits, and TypeScript diagnostics. */
export async function installCodeTooling(
  sandbox: ToolingSandbox,
  options: { readonly vercel?: boolean } = {},
): Promise<void> {
  const paths = toolingPaths(sandbox);
  await Promise.all([
    sandbox.writeTextFile({ path: paths.ghWrapper, content: ghWrapperSource(sandbox) }),
    sandbox.writeTextFile({ path: paths.signedCommit, content: GH_SIGNED_COMMIT_SOURCE }),
    sandbox.writeTextFile({ path: paths.workerSource, content: DIAGNOSTICS_WORKER_SOURCE }),
    ...(options.vercel === true
      ? [
          sandbox.writeTextFile({
            path: paths.vercelWrapper,
            content: vercelWrapperSource(sandbox),
          }),
        ]
      : []),
  ]);
  const install = await sandbox.run({
    command: toolingInstallCommand(sandbox, options.vercel === true),
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `eve-code tooling installation failed (exit ${install.exitCode}): ${commandFailureDetail(install)}`,
    );
  }
}

function toolingInstallCommand(
  sandbox: Pick<SandboxSession, "resolvePath">,
  vercel: boolean,
): string {
  const paths = toolingPaths(sandbox);
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return [
    "set -e",
    `mkdir -p ${quote(paths.root)}`,
    "if ! command -v gh >/dev/null 2>&1; then",
    "  command -v apt-get >/dev/null 2>&1 || { echo 'eve-code requires gh or apt-get' >&2; exit 1; }",
    "  if [ \"$(id -u)\" = 0 ]; then APT=apt-get; else command -v sudo >/dev/null 2>&1 || { echo 'eve-code needs root or sudo to install gh' >&2; exit 1; }; APT='sudo -n apt-get'; fi",
    "  $APT update && $APT install -y gh",
    "fi",
    `chmod 755 ${quote(paths.ghWrapper)} ${quote(paths.signedCommit)}`,
    "if [ \"$(id -u)\" = 0 ]; then INSTALL=install; else INSTALL='sudo -n install'; fi",
    `$INSTALL -d -o root -g root -m 755 ${quote(paths.trustedRoot)} ${quote(paths.typescriptRoot)}`,
    `[ -x /usr/bin/gh ] || { echo 'eve-code requires gh at /usr/bin/gh' >&2; exit 1; }`,
    `$INSTALL -m 755 /usr/bin/gh ${quote(paths.ghReal)}`,
    `$INSTALL -m 755 ${quote(paths.signedCommit)} ${quote(paths.trustedSignedCommit)}`,
    `$INSTALL -m 644 ${quote(paths.workerSource)} ${quote(paths.worker)}`,
    `$INSTALL -m 755 ${quote(paths.ghWrapper)} /usr/local/bin/gh`,
    `$INSTALL -m 755 ${quote(paths.trustedSignedCommit)} /usr/local/bin/gh-signed-commit`,
    typescriptInstallCommand(sandbox),
    ...(vercel
      ? [
          'if [ "$(id -u)" = 0 ]; then npm install -g vercel@latest; else sudo -n npm install -g vercel@latest; fi',
          `$INSTALL -m 755 ${quote(paths.vercelWrapper)} /usr/local/bin/vercel`,
          `$INSTALL -m 755 ${quote(paths.vercelWrapper)} /usr/local/bin/vc`,
        ]
      : []),
  ].join("\n");
}

export {
  authenticateGitHub,
  authenticateVercel,
  type BrokeredCredentialOptions,
} from "./credentials.ts";

export {
  COMPUTER_USE_REVALIDATION_KEY,
  installComputerUse,
  startComputerUse,
} from "./computer-use-sandbox.ts";

export {
  executeGitHubShell,
  githubShellApproval,
  type GitHubLeaseRule,
  type GitHubShellInput,
  type GitHubShellOutput,
} from "./github-shell.ts";
