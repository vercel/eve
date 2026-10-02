const PRUNED_DEVELOPMENT_LAZY_PREWARM_MODULE_ID = "\0eve-pruned-development-lazy-prewarm";
const DEVELOPMENT_LAZY_PREWARM_SOURCE_RE =
  /(?:^|[/\\#])execution[/\\]sandbox[/\\]development-lazy-prewarm\.(?:js|ts)(?:[?#].*)?$/;

interface BundlerPluginShape {
  readonly enforce: "pre";
  readonly name: string;
  load?(id: string): string | null;
  resolveId?(source: string): string | null;
}

/** Removes development-only lazy sandbox preparation from every hosted runtime bundle. */
export function createDevelopmentRuntimePrunePlugin(): BundlerPluginShape {
  return {
    enforce: "pre",
    name: "eve-hosted-development-runtime-prune",
    load(id) {
      return id === PRUNED_DEVELOPMENT_LAZY_PREWARM_MODULE_ID
        ? "export async function ensureDevelopmentSandboxesPrepared() {}\n"
        : null;
    },
    resolveId(source) {
      return DEVELOPMENT_LAZY_PREWARM_SOURCE_RE.test(source)
        ? PRUNED_DEVELOPMENT_LAZY_PREWARM_MODULE_ID
        : null;
    },
  };
}
