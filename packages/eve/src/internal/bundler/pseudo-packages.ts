import { exactRegex, prefixRegex } from "#internal/bundler/filters.js";

const PSEUDO_PACKAGES = new Set([
  "server-only",
  "client-only",
  "next/dist/compiled/server-only",
  "next/dist/compiled/client-only",
]);

const PSEUDO_PACKAGE_ID_PREFIX = "\0eve-pseudo-package:";

export function createPseudoPackagePlugin() {
  return {
    name: "eve-pseudo-packages",
    resolveId: {
      filter: { id: [...PSEUDO_PACKAGES].map((packageName) => exactRegex(packageName)) },
      handler: (source: string) => ({ id: `${PSEUDO_PACKAGE_ID_PREFIX}${source}` }),
    },
    load: {
      filter: { id: prefixRegex(PSEUDO_PACKAGE_ID_PREFIX) },
      handler: () => ({ code: "", moduleType: "js" as const }),
    },
  };
}
