import type { NitroModule } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { exactRegex } from "#internal/bundler/filters.js";

const INSTRUMENTATION_ENTRY = "#eve/instrumentation-entry";
const ENTRY_FILTER = exactRegex(INSTRUMENTATION_ENTRY);

interface EntryPluginContext {
  resolve(source: string): Promise<{ id: string } | null>;
  load(options: { id: string }): Promise<{ exports: readonly string[] | null }>;
}

/**
 * Awaits instrumentation before importing the preset's server dependency
 * graph: the module swaps Nitro's entry for a wrapper the plugin loads.
 */
export function createInstrumentationEntry(instrumentationPath: string) {
  let presetEntry: string | undefined;
  const module: NitroModule = {
    name: "eve:instrumentation-entry",
    setup(nitro) {
      // Module hooks run after preset hooks, which finish selecting the
      // runtime entry in build:before; the bundler reads the entry afterward.
      nitro.hooks.hook("build:before", () => {
        presetEntry = nitro.options.entry;
        nitro.options.entry = INSTRUMENTATION_ENTRY;
      });
    },
  };
  const plugin = {
    name: "eve:instrumentation-entry",
    resolveId: { filter: { id: ENTRY_FILTER }, handler: (id: string) => id },
    load: {
      filter: { id: ENTRY_FILTER },
      async handler(this: EntryPluginContext) {
        if (presetEntry === undefined) throw new Error("Nitro built before selecting its entry.");
        const entry = await this.resolve(presetEntry);
        if (entry === null) throw new Error(`Cannot resolve Nitro entry ${presetEntry}`);
        // Re-export every preset binding, e.g. node-middleware exposes only named exports.
        const { exports } = await this.load(entry);
        return [
          `await import(${stringifyEsmImportSpecifier(instrumentationPath)});`,
          `const server = await import(${stringifyEsmImportSpecifier(presetEntry)});`,
          ...(exports ?? []).map((name) =>
            name === "default"
              ? "export default server.default;"
              : `export const ${name} = server.${name};`,
          ),
        ].join("\n");
      },
    },
  };
  // Nitro's development preset otherwise collapses both startup phases into one module.
  return { inlineDynamicImports: false, module, plugin } as const;
}
