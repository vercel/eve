import type { Nitro } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";

/** Nitro's generated H3Core matcher bypasses H3's HEAD-to-GET fallback. */
export function addNitroHeadFallbackPlugin(nitro: Nitro): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) return;

    config.plugins.unshift({
      name: "eve:nitro-head-fallback",
      transform(code: string, id: string) {
        if (id !== "#nitro/virtual/app") return null;
        const statement = "return findRoute(event.req.method, event.url.pathname);";
        if (!code.includes(statement)) {
          throw new Error(
            "Nitro's generated route matcher changed; review eve's HEAD fallback integration.",
          );
        }
        const runtime = stringifyEsmImportSpecifier(
          resolvePackageSourceFilePath("src/internal/nitro/routes/head-fallback.ts"),
        );
        return {
          code:
            `import { findRouteWithHeadFallback } from ${runtime};\n` +
            code.replace(
              statement,
              "return findRouteWithHeadFallback(findRoute, event.req.method, event.url.pathname);",
            ),
          map: null,
        };
      },
    });
  });
}
