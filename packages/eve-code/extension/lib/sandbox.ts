/** Consumer-facing helpers exported as `eve/extensions/code/sandbox`. */
import type { SandboxSession } from "eve/sandbox";

import { commandFailureDetail } from "./command-failure.ts";
import {
  DIAGNOSTICS_WORKER_SOURCE,
  GH_SIGNED_COMMIT_SOURCE,
  GH_SIGNED_COMMIT_VERSION,
  GH_TARBALL_SHA256,
  GH_VERSION,
  ghWrapperSource,
  toolingPaths,
  TYPESCRIPT_VERSION,
  typescriptInstallCommand,
  vercelWrapperSource,
} from "./tooling.ts";

type ToolingSandbox = Pick<SandboxSession, "resolvePath" | "run" | "writeTextFile">;

/** Include in the consumer's sandbox `revalidationKey` so cached templates rebuild when the tooling changes. */
export const CODE_TOOLING_REVALIDATION_KEY = `eve-code-tooling:3:${GH_VERSION}:${GH_SIGNED_COMMIT_VERSION}:${TYPESCRIPT_VERSION}`;

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
    `chmod 755 ${quote(paths.ghWrapper)} ${quote(paths.signedCommit)}`,
    "if [ \"$(id -u)\" = 0 ]; then INSTALL=install; else INSTALL='sudo -n install'; fi",
    `$INSTALL -d -o root -g root -m 755 ${quote(paths.trustedRoot)} ${quote(paths.typescriptRoot)}`,
    'case "$(uname -m)" in',
    `  x86_64) GH_ARCH=amd64 GH_SHA256=${GH_TARBALL_SHA256.amd64} ;;`,
    `  aarch64) GH_ARCH=arm64 GH_SHA256=${GH_TARBALL_SHA256.aarch64} ;;`,
    `  *) echo "eve-code has no gh build for $(uname -m)" >&2; exit 1 ;;`,
    "esac",
    'GH_TMP="$(mktemp -d)"',
    `curl --retry 3 -fsSL -o "$GH_TMP/gh.tar.gz" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$GH_ARCH.tar.gz"`,
    'echo "$GH_SHA256  $GH_TMP/gh.tar.gz" | sha256sum -c -',
    `tar -xzf "$GH_TMP/gh.tar.gz" -C "$GH_TMP" --strip-components=2 "gh_${GH_VERSION}_linux_$GH_ARCH/bin/gh"`,
    `$INSTALL -m 755 "$GH_TMP/gh" ${quote(paths.ghReal)}`,
    'rm -rf "$GH_TMP"',
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
