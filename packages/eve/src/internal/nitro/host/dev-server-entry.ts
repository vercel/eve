import { createRequire } from "node:module";

import type { Nitro } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";

const DEVELOPMENT_SERVER_ENTRY = "#eve/dev-server-entry";

/** Lets the dev worker attach the WebSocket adapter of the runtime it runs in. */
export function configureDevelopmentServerEntry(nitro: Nitro): void {
  if (!/\/_nitro\/runtime\/nitro-dev(?:\.mjs)?$/.test(nitro.options.entry.replaceAll("\\", "/"))) {
    throw new Error(
      `eve replaces Nitro's nitro-dev entry, but Nitro now uses "${nitro.options.entry}". Check whether it ships nitrojs/nitro#4711 and drop eve's dev entry.`,
    );
  }
  nitro.options.virtual[DEVELOPMENT_SERVER_ENTRY] = createDevelopmentServerEntrySource();
  nitro.options.entry = DEVELOPMENT_SERVER_ENTRY;
}

// Nitro's `nitro-dev` entry, except WebSocket hooks go to env-runner instead of
// a hard-coded crossws Node adapter, which throws in Bun. Mirrors nitrojs/nitro#4711;
// drop this once eve's Nitro version ships that change.
function createDevelopmentServerEntrySource(): string {
  const nitro = createNitroImportResolver();
  return `import "#nitro/virtual/polyfills";
import { useNitroApp, useNitroHooks } from ${nitro("nitro/app")};
import { startScheduleRunner } from ${nitro("#nitro/runtime/task")};
import { trapUnhandledErrors } from ${nitro("#nitro/runtime/error/hooks")};
import { resolveWebsocketHooks } from ${nitro("#nitro/runtime/app")};
import { tracingSrvxPlugins } from "#nitro/virtual/tracing";

const nitroApp = useNitroApp();
const nitroHooks = useNitroHooks();
trapUnhandledErrors();

if (import.meta._tasks) {
  startScheduleRunner({});
}

export default {
  fetch: nitroApp.fetch,
  plugins: [...tracingSrvxPlugins],
  websocket: import.meta._websocket ? { resolve: resolveWebsocketHooks } : undefined,
  ipc: { onClose: () => nitroHooks.callHook("close") },
};
`;
}

/**
 * Resolves imports the way Nitro's own entry does: `#nitro/runtime/*` is
 * Nitro-private, and the app need not depend on `nitro` directly.
 */
function createNitroImportResolver(): (specifier: string) => string {
  const nitroRequire = createRequire(createRequire(import.meta.url).resolve("nitro/package.json"));
  return (specifier) => stringifyEsmImportSpecifier(nitroRequire.resolve(specifier));
}
