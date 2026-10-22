import { join } from "node:path";

import { copyDirectoryAtomically } from "#execution/sandbox/bindings/local-provider-utils.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

function resolveImmutableResourcesPath(input: {
  readonly storagePath: string;
  readonly provider: string;
  readonly resourcesKey: string;
}): string {
  return join(input.storagePath, input.provider, "resources", input.resourcesKey);
}

export async function prepareImmutableResources(input: {
  readonly storagePath: string;
  readonly provider: string;
  readonly resourcesKey: string;
  readonly sourcePath: string;
}): Promise<string> {
  const path = resolveImmutableResourcesPath(input);
  await copyDirectoryAtomically(input.sourcePath, path);
  return path;
}

/** `quotedRoot` is interpolated into the shell script, so callers pass it shell-quoted. */
export async function hydrateSandboxFromImmutableResources(
  session: SandboxSession,
  quotedRoot: string,
): Promise<void> {
  const result = await session.run({
    command: [
      "set -e",
      `if [ -d ${quotedRoot}/workspace ]; then cp -a ${quotedRoot}/workspace/. /workspace/; fi`,
      `if [ -d ${quotedRoot}/skills ]; then`,
      '  mkdir -p "$HOME/.agents"',
      '  rm -rf "$HOME/.agents/skills"',
      '  mkdir -p "$HOME/.agents/skills"',
      `  cp -a ${quotedRoot}/skills/. "$HOME/.agents/skills/"`,
      "fi",
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to hydrate sandbox resources: ${result.stderr || result.stdout}`);
  }
}
