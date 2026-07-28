/**
 * Framework marker packages that exist only to assert a module's intended
 * environment. eve bundles authored and hosted application code exclusively
 * for the server, so these markers have no runtime behavior in an eve bundle.
 */
export const PSEUDO_PACKAGE_SPECIFIERS = [
  "server-only",
  "client-only",
  "next/dist/compiled/server-only",
  "next/dist/compiled/client-only",
] as const;

const PSEUDO_PACKAGE_SPECIFIER_SET = new Set<string>(PSEUDO_PACKAGE_SPECIFIERS);
const VIRTUAL_PREFIX = "\0eve-pseudo-package:";

/** The shared subset of the Rolldown/Rollup plugin shape used by eve bundlers. */
export interface PseudoPackageBundlerPlugin {
  readonly name: string;
  resolveId(source: string): { id: string } | undefined;
  load(id: string): { code: string; moduleType: "js" } | undefined;
}

/**
 * Resolves framework-only marker packages to empty virtual modules.
 *
 * This plugin belongs in every eve-owned server bundling path. Keeping the
 * marker handling here prevents discovery, immutable generation, Workflow,
 * and Nitro host bundles from drifting into different behavior.
 */
export function createPseudoPackagePlugin(): PseudoPackageBundlerPlugin {
  return {
    name: "eve-pseudo-packages",
    resolveId(source: string) {
      if (!PSEUDO_PACKAGE_SPECIFIER_SET.has(source)) {
        return undefined;
      }

      return { id: `${VIRTUAL_PREFIX}${source}` };
    },
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return undefined;
      }

      return {
        code: "",
        moduleType: "js",
      };
    },
  };
}
