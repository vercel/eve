import { normalizeGeneratedEsmImportSpecifiers } from "#internal/application/import-specifier.js";

/**
 * Rewrites Nitro's generated routing modules before the bundler resolves their
 * imports so raw Windows drive-letter paths become valid file URLs.
 */
export function createNitroRoutingImportSpecifierPlugin() {
  return {
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
  };
}
