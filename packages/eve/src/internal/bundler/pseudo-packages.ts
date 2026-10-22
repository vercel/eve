// Marker packages that only assert which React environment imports them. eve
// bundles run on the server outside React's module graph, so each loads as an
// empty module instead of resolving: `server-only` throws without the
// `react-server` condition, and a strict pnpm layout often cannot resolve the
// marker from where the bundle is evaluated.
const PSEUDO_PACKAGES = new Set([
  "server-only",
  "client-only",
  "next/dist/compiled/server-only",
  "next/dist/compiled/client-only",
]);

const PSEUDO_PACKAGE_ID_PREFIX = "\0eve-pseudo-package:";

/** Must run before any plugin that externalizes or resolves package imports. */
export function createPseudoPackagePlugin() {
  return {
    name: "eve-pseudo-packages",
    resolveId(source: string) {
      return PSEUDO_PACKAGES.has(source)
        ? { id: `${PSEUDO_PACKAGE_ID_PREFIX}${source}` }
        : undefined;
    },
    load(id: string) {
      return id.startsWith(PSEUDO_PACKAGE_ID_PREFIX)
        ? { code: "", moduleType: "js" as const }
        : undefined;
    },
  };
}
