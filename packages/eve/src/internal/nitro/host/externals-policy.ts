import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { resolvePackageSourceDirectoryPath } from "#internal/application/package.js";
import { parseExtensionMountId } from "#internal/bundler/extension-mount-plugin.js";
import {
  collectHostTracedDependencies,
  OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
} from "#internal/host-traced-dependencies.js";

const LOCAL_SANDBOX_BACKEND_NAMES = new Set([
  "docker",
  ...Object.keys(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME),
]);

export interface ExternalsPolicy {
  readonly traceDeps: readonly string[];
  readonly untracedExternals: readonly string[];
  readonly checkedExternals: readonly string[];
  readonly pruneSandboxProviders: boolean;
  readonly pruneDevelopmentRuntime: boolean;
}

export function createExternalsPolicy(input: {
  readonly manifest: CompiledAgentManifest;
  readonly development: boolean;
  readonly preset: "vercel" | undefined;
}): ExternalsPolicy {
  const { manifest } = input;
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const backendNames = new Set(
    nodes
      .map((node) => node.sandbox?.providerName)
      .filter((providerName): providerName is string => providerName !== undefined),
  );
  const untracedExternals = Object.entries(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME)
    .filter(([backendName]) => !backendNames.has(backendName))
    .map(([, packageName]) => packageName);
  const configuredExternals = [
    ...(manifest.config.build?.externalDependencies ?? []),
    ...manifest.subagents.flatMap((subagent) =>
      subagent.configResolver === undefined
        ? (subagent.agent.config.build?.externalDependencies ?? [])
        : [],
    ),
  ];

  const production = !input.development;
  return {
    checkedExternals: production ? configuredExternals : [],
    pruneDevelopmentRuntime: production,
    pruneSandboxProviders:
      input.preset === "vercel" &&
      ![...backendNames].some((backendName) => LOCAL_SANDBOX_BACKEND_NAMES.has(backendName)),
    traceDeps: production ? collectHostTracedDependencies(manifest) : [],
    untracedExternals,
  };
}

export function createHostNoExternals(stepTargets: readonly string[]): string[] {
  return [
    `${resolvePackageSourceDirectoryPath("src/execution")}/`,
    ...new Set(stepTargets.map((target) => parseExtensionMountId(target).filePath)),
  ];
}
