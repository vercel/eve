/**
 * Optional sandbox engine packages referenced by eve's lazy runtime loaders.
 * They remain application-owned dependencies: eve never bundles them into its
 * package or an authored generation merely because a framework source makes
 * the loader graph reachable.
 */
export const OPTIONAL_SANDBOX_ENGINE_PACKAGES_BY_BACKEND_NAME: Readonly<Record<string, string>> = {
  "just-bash": "just-bash",
  microsandbox: "microsandbox",
};

interface BundlerPluginShape {
  readonly name: string;
  resolveId?(
    source: string,
    importer: string | undefined,
  ): { external: true; id: string } | null | undefined;
}

/**
 * Marks the selected optional sandbox engines as explicit externals. Rolldown
 * follows literal dynamic imports while producing a single-file authored
 * generation, so relying on its unresolved-import fallback emits warnings and
 * makes an unselected backend affect `eve dev`. Explicit externalization keeps
 * those loaders lazy and leaves package resolution to the application if the
 * backend is eventually selected.
 *
 * Hosted Nitro builds pass only unconfigured engines: configured engines take
 * Nitro's externalize-and-trace path so the deployment remains self-contained.
 */
export function createOptionalSandboxEngineDependencyPlugin(
  externalPackages: readonly string[],
): BundlerPluginShape | null {
  if (externalPackages.length === 0) {
    return null;
  }

  const externals = new Set(externalPackages);

  return {
    name: "eve-optional-sandbox-engine-dependency-external",
    resolveId(source) {
      if (!externals.has(source)) {
        return null;
      }

      return { external: true, id: source };
    },
  };
}
