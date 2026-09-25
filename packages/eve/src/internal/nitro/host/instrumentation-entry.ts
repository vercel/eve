import type { Nitro } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";

const INSTRUMENTATION_ENTRY = "#eve/instrumentation-entry";

/** Awaits instrumentation before importing the preset's server dependency graph. */
export function configureInstrumentationEntry(nitro: Nitro, instrumentationPath: string): void {
  // Nitro's development preset otherwise collapses both startup phases into one module.
  nitro.options.inlineDynamicImports = false;
  nitro.options.virtual[INSTRUMENTATION_ENTRY] = () =>
    [
      `await import(${stringifyEsmImportSpecifier(instrumentationPath)});`,
      `const { default: server } = await import(${stringifyEsmImportSpecifier(nitro.options.entry)});`,
      "export default server;",
    ].join("\n");

  // Presets finish selecting their runtime entry in build:before.
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    config.input = INSTRUMENTATION_ENTRY;
  });
}
