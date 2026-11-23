import type { NitroModule } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { exactRegex } from "#internal/bundler/filters.js";

const INSTRUMENTATION_ENTRY = "#eve/instrumentation-entry";
const APP_MODULE = "#eve/app.mjs";
const EVE_APP = "eve:app";
const EVE_INSTRUMENTATION = "eve:instrumentation";

interface EntryPluginContext {
  resolve(source: string): Promise<{ id: string } | null>;
  load(options: { id: string }): Promise<{ exports: readonly string[] | null }>;
}

export function createInstrumentationEntry(instrumentationPath: string, platformEntry?: string) {
  let presetEntry: string | undefined;
  const hostEntry = platformEntry ?? INSTRUMENTATION_ENTRY;
  const builtIds = platformEntry === undefined ? [INSTRUMENTATION_ENTRY] : [APP_MODULE];
  const importedIds = platformEntry === undefined ? [] : [EVE_APP, EVE_INSTRUMENTATION];
  const serverEntry = () => {
    if (presetEntry === undefined) throw new Error("Nitro built before selecting its entry.");
    return presetEntry;
  };
  const module: NitroModule = {
    name: "eve:instrumentation-entry",
    setup(nitro) {
      nitro.hooks.hook("build:before", () => {
        if (nitro.options.entry === hostEntry) return;
        presetEntry = nitro.options.entry;
        nitro.options.entry = hostEntry;
      });
    },
  };
  const plugin = {
    name: "eve:instrumentation-entry",
    resolveId: {
      filter: { id: [...builtIds, ...importedIds].map((id) => exactRegex(id)) },
      handler: (id: string) =>
        id === EVE_APP ? APP_MODULE : id === EVE_INSTRUMENTATION ? instrumentationPath : id,
    },
    load: {
      filter: { id: builtIds.map((id) => exactRegex(id)) },
      async handler(this: EntryPluginContext, id: string) {
        if (id === APP_MODULE) return createAppModuleSource(serverEntry());
        const entry = await this.resolve(serverEntry());
        if (entry === null) throw new Error(`Cannot resolve Nitro entry ${serverEntry()}`);
        const { exports } = await this.load(entry);
        return [
          `await import(${stringifyEsmImportSpecifier(instrumentationPath)});`,
          `const server = await import(${stringifyEsmImportSpecifier(serverEntry())});`,
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

function createAppModuleSource(serverEntry: string): string {
  const runtimePath = resolvePackageSourceFilePath("src/internal/nitro/host/entry-app-runtime.ts");
  return [
    `import { createEntryAppStart } from ${stringifyEsmImportSpecifier(runtimePath)};`,
    `export const start = createEntryAppStart(() => import(${stringifyEsmImportSpecifier(serverEntry)}));`,
  ].join("\n");
}
