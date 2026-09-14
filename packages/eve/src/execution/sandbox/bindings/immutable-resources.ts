import { join } from "node:path";

import { copyDirectoryAtomically } from "#execution/sandbox/bindings/local-provider-utils.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export const SANDBOX_RESOURCES_ROOT = "/eve/resources";

export function resolveImmutableResourcesPath(input: {
  readonly appRoot: string;
  readonly provider: string;
  readonly resourcesKey: string;
}): string {
  return join(
    resolveSandboxCacheDirectory(input.appRoot),
    input.provider,
    "resources",
    input.resourcesKey,
  );
}

export async function prepareImmutableResources(input: {
  readonly appRoot: string;
  readonly provider: string;
  readonly resourcesKey: string;
  readonly sourcePath: string;
}): Promise<string> {
  const path = resolveImmutableResourcesPath(input);
  await copyDirectoryAtomically(input.sourcePath, path);
  return path;
}

export async function hydrateSandboxFromImmutableResources(session: SandboxSession): Promise<void> {
  const result = await session.run({
    command: [
      "set -e",
      `if [ -d ${SANDBOX_RESOURCES_ROOT}/workspace ]; then cp -a ${SANDBOX_RESOURCES_ROOT}/workspace/. /workspace/; fi`,
      `if [ -d ${SANDBOX_RESOURCES_ROOT}/skills ]; then`,
      '  mkdir -p "$HOME/.agents"',
      '  rm -rf "$HOME/.agents/skills"',
      `  ln -s ${SANDBOX_RESOURCES_ROOT}/skills "$HOME/.agents/skills"`,
      "fi",
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to hydrate sandbox resources: ${result.stderr || result.stdout}`);
  }
}
