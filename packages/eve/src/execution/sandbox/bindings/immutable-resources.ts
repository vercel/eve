import { join } from "node:path";

import {
  copyDirectoryAtomically,
  writeSandboxSeedFiles,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  providerResourceTargetFiles,
  type SandboxProviderResources,
} from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export const SANDBOX_RESOURCES_ROOT = "/eve/resources";

export function resolveImmutableResourcesPath(input: {
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

export async function hydrateSandboxProviderResources(input: {
  readonly copySkills?: boolean;
  readonly log?: (message: string) => void;
  readonly resources: SandboxProviderResources;
  readonly session: SandboxSession;
}): Promise<void> {
  switch (input.resources.source.kind) {
    case "none":
    case "inline":
      await writeSandboxSeedFiles(input.session, providerResourceTargetFiles(input.resources));
      return;
    case "materialized":
      input.log?.("hydrating workspace and skills from read-only resources");
      await hydrateSandboxFromImmutableResources(input.session, input.copySkills);
      return;
  }
}

export async function hydrateSandboxFromImmutableResources(
  session: SandboxSession,
  copySkills = false,
): Promise<void> {
  const hydrateSkills = copySkills
    ? [
        '  mkdir -p "$HOME/.agents/skills"',
        `  cp -a ${SANDBOX_RESOURCES_ROOT}/skills/. "$HOME/.agents/skills/"`,
      ]
    : [`  ln -s ${SANDBOX_RESOURCES_ROOT}/skills "$HOME/.agents/skills"`];
  const result = await session.run({
    command: [
      "set -e",
      `if [ -d ${SANDBOX_RESOURCES_ROOT}/workspace ]; then cp -a ${SANDBOX_RESOURCES_ROOT}/workspace/. /workspace/; fi`,
      `if [ -d ${SANDBOX_RESOURCES_ROOT}/skills ]; then`,
      '  mkdir -p "$HOME/.agents"',
      '  rm -rf "$HOME/.agents/skills"',
      ...hydrateSkills,
      "fi",
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to hydrate sandbox resources: ${result.stderr || result.stdout}`);
  }
}
