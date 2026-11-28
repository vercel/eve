import { dirname } from "node:path";

import type { CompiledAgentManifest, CompiledExtensionMount } from "#compiler/manifest.js";
import { resolvePackageSourceDirectoryPath } from "#internal/application/package.js";
import {
  canonicalizePath,
  parseExtensionMountId,
} from "#internal/bundler/extension-mount-plugin.js";
import { escapeRegex } from "#internal/bundler/filters.js";
import {
  collectHostTracedDependencies,
  OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
} from "#internal/host-traced-dependencies.js";

const LOCAL_SANDBOX_BACKEND_NAMES = new Set([
  "docker",
  "host",
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

function exactPackageSpecifierRegex(specifier: string): RegExp {
  return new RegExp(`^${escapeRegex(specifier)}(?:[/?#]|$)`);
}

export function createHostNoExternals(
  stepTargets: readonly string[],
  extensionMounts: readonly CompiledExtensionMount[] = [],
): (string | RegExp)[] {
  const seenSpecifiers = new Set<string>();
  const specifierPatterns: RegExp[] = [];
  const addSpecifier = (specifier: string) => {
    if (seenSpecifiers.has(specifier)) return;
    seenSpecifiers.add(specifier);
    specifierPatterns.push(exactPackageSpecifierRegex(specifier));
  };
  const mountPaths = extensionMounts.flatMap((mount) => {
    addSpecifier(mount.specifier);
    const canonicalRoot = canonicalizePath(mount.sourceRoot);
    const entries = [
      `${mount.sourceRoot}/`,
      `${dirname(mount.sourceRoot)}/`,
      `${canonicalRoot}/`,
      `${dirname(canonicalRoot)}/`,
    ];
    if (mount.programmaticImport !== undefined) {
      addSpecifier(mount.programmaticImport.specifier);
      entries.push(mount.programmaticImport.entryPath);
    }
    return entries;
  });
  return [
    `${resolvePackageSourceDirectoryPath("src/execution")}/`,
    ...new Set([
      ...stepTargets.map((target) => parseExtensionMountId(target).filePath),
      ...mountPaths,
    ]),
    ...specifierPatterns,
  ];
}
