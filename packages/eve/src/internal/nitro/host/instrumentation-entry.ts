import type { NitroModule } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { exactRegex } from "#internal/bundler/filters.js";

const INSTRUMENTATION_ENTRY = "#eve/instrumentation-entry";
const ENTRY_FILTER = exactRegex(INSTRUMENTATION_ENTRY);

interface EntryPluginContext {
  resolve(source: string): Promise<{ id: string } | null>;
  load(options: { id: string }): Promise<{ exports: readonly string[] | null }>;
}

export function createInstrumentationEntry(instrumentationPath: string) {
  let presetEntry: string | undefined;
  const module: NitroModule = {
    name: "eve:instrumentation-entry",
    setup(nitro) {
      nitro.hooks.hook("build:before", () => {
        if (nitro.options.entry === INSTRUMENTATION_ENTRY) return;
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
  return { inlineDynamicImports: false, module, plugin } as const;
}
