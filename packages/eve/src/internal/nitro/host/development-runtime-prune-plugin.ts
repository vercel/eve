const PRUNED_DEVELOPMENT_LAZY_PREWARM_MODULE_ID = "\0eve-pruned-development-lazy-prewarm";
const DEVELOPMENT_LAZY_PREWARM_SOURCE_RE =
  /(?:^|[/\\#])execution[/\\]sandbox[/\\]development-lazy-prewarm\.(?:js|ts)(?:[?#].*)?$/;
const PRUNED_OPTIONAL_ENGINE_INSTALL_MODULE_ID = "\0eve-pruned-optional-engine-install";
const OPTIONAL_ENGINE_INSTALL_SOURCE_RE =
  /(?:^|[/\\#])internal[/\\]application[/\\]optional-package-install\.(?:js|ts)(?:[?#].*)?$/;

interface BundlerPluginShape {
  readonly enforce: "pre";
  readonly name: string;
  load?(id: string): string | null;
  resolveId?(source: string): string | null;
}

/**
 * Removes development-only lazy sandbox preparation, and the optional engine
 * installer only preparation uses, from every production runtime bundle.
 */
export function createDevelopmentRuntimePrunePlugin(): BundlerPluginShape {
  return {
    enforce: "pre",
    name: "eve-hosted-development-runtime-prune",
    load(id) {
      if (id === PRUNED_DEVELOPMENT_LAZY_PREWARM_MODULE_ID) {
        return "export async function ensureDevelopmentSandboxesPrepared() {}\n";
      }
      if (
        id === PRUNED_OPTIONAL_ENGINE_INSTALL_MODULE_ID ||
        OPTIONAL_ENGINE_INSTALL_SOURCE_RE.test(id)
      ) {
        return [
          "function pruned() {",
          '  throw new Error("Optional local sandbox engines cannot be installed in production server runtimes.");',
          "}",
          "export const detectProjectPackageManager = pruned;",
          "export const importInstalledEnginePackage = pruned;",
          "export const installPackageIntoProject = pruned;",
          "export const loadOptionalEnginePackage = pruned;",
          "",
        ].join("\n");
      }
      return null;
    },
    resolveId(source) {
      if (DEVELOPMENT_LAZY_PREWARM_SOURCE_RE.test(source)) {
        return PRUNED_DEVELOPMENT_LAZY_PREWARM_MODULE_ID;
      }
      if (OPTIONAL_ENGINE_INSTALL_SOURCE_RE.test(source)) {
        return PRUNED_OPTIONAL_ENGINE_INSTALL_MODULE_ID;
      }
      return null;
    },
  };
}
