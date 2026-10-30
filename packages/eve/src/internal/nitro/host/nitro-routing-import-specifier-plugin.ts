import { normalizeGeneratedEsmImportSpecifiers } from "#internal/application/import-specifier.js";
import { exactRegex } from "#internal/bundler/filters.js";

/**
 * Rewrites Nitro's generated routing modules before the bundler resolves their
 * imports so raw Windows drive-letter paths become valid file URLs.
 */
export function createNitroRoutingImportSpecifierPlugin() {
  return {
    name: "eve:nitro-routing-import-specifiers",
    transform: {
      filter: {
        id: [exactRegex("#nitro/virtual/routing"), exactRegex("#nitro/virtual/routing-meta")],
      },
      handler(code: string) {
        const nextCode = normalizeGeneratedEsmImportSpecifiers(code);
        return nextCode === code ? null : { code: nextCode, map: null };
      },
    },
  };
}
