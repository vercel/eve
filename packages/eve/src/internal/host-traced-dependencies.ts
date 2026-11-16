import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/**
 * Optional sandbox engines eve's runtime reaches through lazy dynamic imports.
 * Bundlers follow literal dynamic imports, so mere resolvability (for example
 * eve's own workspace devDependencies) would pull them into every hosted
 * build. The compiled sandbox config's backend names are the app's opt-in.
 */
export const OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME: Readonly<Record<string, string>> = {
  "just-bash": "just-bash",
};

/**
 * Packages the production host externalizes and traces wherever the hosted graph imports them.
 * Extension-owned externals are `name*` patterns. Generated bundles read this list too, so the
 * packages they hand to the host can't widen what these patterns match.
 */
export function collectHostTracedDependencies(manifest: CompiledAgentManifest): string[] {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const backendNames = new Set(nodes.map((node) => node.sandbox?.providerName));
  const configuredEngines = Object.entries(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME)
    .filter(([backendName]) => backendNames.has(backendName))
    .map(([, packageName]) => packageName);
  const configuredExternals = [
    ...(manifest.config.build?.externalDependencies ?? []),
    ...manifest.subagents.flatMap((subagent) =>
      subagent.configResolver === undefined
        ? (subagent.agent.config.build?.externalDependencies ?? [])
        : [],
    ),
  ];
  const extensionExternals = nodes
    .flatMap((node) => node.extensionMounts)
    .flatMap((mount) => mount.externalDependencies)
    .map((dependency) => `${dependency}*`);

  return [...new Set([...configuredEngines, ...configuredExternals, ...extensionExternals])].filter(
    (dependency) => dependency !== EVE_PACKAGE_NAME && dependency !== `${EVE_PACKAGE_NAME}*`,
  );
}

/** Whether a package name matches a host-traced dependency, including `name*` patterns. */
export function matchesHostTracedDependency(
  packageName: string,
  tracedDependencies: readonly string[],
): boolean {
  return tracedDependencies.some((dependency) =>
    dependency.endsWith("*")
      ? packageName.startsWith(dependency.slice(0, -1))
      : packageName === dependency,
  );
}
