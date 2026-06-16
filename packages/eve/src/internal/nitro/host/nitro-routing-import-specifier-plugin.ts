import type { Nitro } from "nitro/types";

import { normalizeGeneratedEsmImportSpecifiers } from "#internal/application/import-specifier.js";

/**
 * Patches Nitro's generated routing modules before Rollup/Rolldown resolves
 * their imports so raw Windows drive-letter paths become valid file URLs.
 */
export function addNitroRoutingImportSpecifierPlugin(nitro: Nitro): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:nitro-routing-import-specifiers",
      transform(code: string, id: string) {
        if (id !== "#nitro/virtual/routing" && id !== "#nitro/virtual/routing-meta") {
          return null;
        }

        const nextCode = normalizeGeneratedEsmImportSpecifiers(code);
        if (nextCode === code) {
          return null;
        }

        return {
          code: nextCode,
          map: null,
        };
      },
    });
  });
}
