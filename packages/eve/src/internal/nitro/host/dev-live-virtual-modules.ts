import type { Nitro } from "nitro/types";

/**
 * Nitro's dev watcher creates its bundler config once and reuses it across
 * `rollup:reload`, and the `nitro:virtual` plugin snapshots
 * `nitro.options.virtual` into a private module map when that config is
 * created. Mutating `nitro.options.virtual` after startup therefore never
 * reaches the bundler — a virtual handler added for a new channel route
 * fails with UNRESOLVED_IMPORT and kills the dev worker until restart.
 *
 * The plugin exposes its live module map through its `api`, so we capture
 * it from the `rollup:before` hook and mirror later virtual-module updates
 * into it. Ids must start with `#nitro/virtual/` — the plugin's resolveId
 * filter is also frozen at creation, and that prefix is the only pattern it
 * always accepts.
 */

interface NitroVirtualModuleEntry {
  readonly module: { readonly id: string; readonly template: string };
  readonly render: () => string;
}

type LiveVirtualModuleMap = Map<string, NitroVirtualModuleEntry>;

const liveVirtualModuleMaps = new WeakMap<object, LiveVirtualModuleMap>();

/**
 * Starts capturing the dev bundler's live virtual-module map for `nitro`.
 * Call once per dev Nitro instance, before its first build.
 */
export function captureDevLiveVirtualModules(nitro: Nitro): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    const moduleMap = findNitroVirtualModuleMap(config.plugins);
    if (moduleMap !== undefined) {
      liveVirtualModuleMaps.set(nitro, moduleMap);
    }
  });
}

/**
 * Mirrors one virtual-module set into the captured dev bundler map: ids
 * under `prefix` are replaced by `entries`. Returns `false` when no live
 * map was captured (the caller should tell the user a restart is needed).
 */
export function replaceDevLiveVirtualModules(
  nitro: object,
  input: {
    readonly entries: Readonly<Record<string, string>>;
    readonly prefix: string;
  },
): boolean {
  const moduleMap = liveVirtualModuleMaps.get(nitro);

  if (moduleMap === undefined) {
    return false;
  }

  for (const id of moduleMap.keys()) {
    if (id.startsWith(input.prefix)) {
      moduleMap.delete(id);
    }
  }

  for (const [id, template] of Object.entries(input.entries)) {
    moduleMap.set(id, {
      module: { id, template },
      render: () => template,
    });
  }

  return true;
}

function findNitroVirtualModuleMap(plugins: unknown): LiveVirtualModuleMap | undefined {
  if (!Array.isArray(plugins)) {
    return undefined;
  }

  for (const plugin of plugins.flat(Number.POSITIVE_INFINITY)) {
    if (
      typeof plugin === "object" &&
      plugin !== null &&
      (plugin as { name?: unknown }).name === "nitro:virtual"
    ) {
      const api = (plugin as { api?: { modules?: unknown } }).api;
      if (api !== undefined && api.modules instanceof Map) {
        return api.modules as LiveVirtualModuleMap;
      }
    }
  }

  return undefined;
}
