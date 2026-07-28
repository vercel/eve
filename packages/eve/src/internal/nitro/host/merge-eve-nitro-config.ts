import type { Nitro, NitroConfig } from "nitro/types";

import type { EveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";

type BundlerLogHandler = (
  level: string,
  log: unknown,
  defaultHandler: (level: string, log: unknown) => void,
) => void;

function mergeUnique<T>(existing: readonly T[] | undefined, added: readonly T[]): T[] {
  return [...new Set([...(existing ?? []), ...added])];
}

function normalizeBundlerPlugins(plugins: unknown): unknown[] {
  if (plugins === undefined) {
    return [];
  }

  return Array.isArray(plugins) ? plugins : [plugins];
}

function mergeBundlerConfig(
  existing: Record<string, unknown> | undefined,
  added: Record<string, unknown>,
): Record<string, unknown> {
  const existingPlugins = normalizeBundlerPlugins(existing?.plugins);
  const addedPlugins = normalizeBundlerPlugins(added.plugins);
  const existingOnLog = existing?.onLog;
  const addedOnLog = added.onLog;
  const merged: Record<string, unknown> = {
    ...existing,
    ...added,
    plugins: [...existingPlugins, ...addedPlugins],
  };

  if (typeof existingOnLog === "function" && typeof addedOnLog === "function") {
    merged.onLog = (
      level: string,
      log: unknown,
      defaultHandler: (level: string, log: unknown) => void,
    ) =>
      (addedOnLog as BundlerLogHandler)(level, log, (forwardedLevel, forwardedLog) => {
        (existingOnLog as BundlerLogHandler)(forwardedLevel, forwardedLog, defaultHandler);
      });
  }

  return merged;
}

/** Host-owned arrays and nested bundler settings must survive eve installation. */
export function mergeEveNitroConfig(
  hostConfig: NitroConfig,
  contribution: EveNitroContribution,
): NitroConfig {
  const delta = contribution.configDelta;
  const plugins = mergeUnique(hostConfig.plugins, delta.plugins);
  const scanDirs = mergeUnique(hostConfig.scanDirs, delta.scanDirs);
  const traceDeps = mergeUnique(hostConfig.traceDeps, delta.traceDeps);
  const merged: NitroConfig = {
    ...hostConfig,
    features: {
      ...hostConfig.features,
      ...delta.features,
      websocket: Boolean(hostConfig.features?.websocket || delta.features.websocket),
    },
    rolldownConfig: mergeBundlerConfig(
      hostConfig.rolldownConfig as Record<string, unknown> | undefined,
      delta.rolldownConfig as Record<string, unknown>,
    ) as NitroConfig["rolldownConfig"],
    rollupConfig: mergeBundlerConfig(
      hostConfig.rollupConfig as Record<string, unknown> | undefined,
      delta.rollupConfig as Record<string, unknown>,
    ) as NitroConfig["rollupConfig"],
  };

  if (plugins.length > 0) {
    merged.plugins = plugins;
  }
  if (scanDirs.length > 0) {
    merged.scanDirs = scanDirs;
  }
  if (traceDeps.length > 0) {
    merged.traceDeps = traceDeps;
  }

  return merged;
}

/** Applies only eve-owned additive configuration to an initialized Nitro host. */
export function applyEveNitroConfigDelta(nitro: Nitro, contribution: EveNitroContribution): void {
  const merged = mergeEveNitroConfig(nitro.options, contribution);

  nitro.options.features = merged.features ?? nitro.options.features;
  nitro.options.plugins = merged.plugins ?? nitro.options.plugins;
  nitro.options.rolldownConfig = merged.rolldownConfig;
  nitro.options.rollupConfig = merged.rollupConfig;
  nitro.options.scanDirs = merged.scanDirs ?? nitro.options.scanDirs;
  nitro.options.traceDeps = merged.traceDeps;
}
