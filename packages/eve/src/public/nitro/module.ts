import { resolve } from "node:path";

import type { Nitro } from "nitro/types";

import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
  type ApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import {
  applyProductionEveNitroContribution,
  configureInitialStandaloneDevelopmentEveNitroContribution,
} from "#internal/nitro/host/apply-eve-nitro-contribution.js";
import { createEmbeddedEveNitroRequirements } from "#internal/nitro/host/embedded-eve-nitro-requirements.js";
import { configureEmbeddedProductionArtifacts } from "#internal/nitro/host/embedded-production-artifacts.js";
import { createEmbeddedDevelopmentRebuildCoordinator } from "#internal/nitro/host/embedded-development-rebuild-coordinator.js";
import {
  beginEmbeddedEveNitroInstallation,
  validateEmbeddedEveNitroHost,
} from "#internal/nitro/host/embedded-nitro-host-validation.js";
import { stageEmbeddedRouteTopology } from "#internal/nitro/host/embedded-route-topology.js";
import {
  createEveNitroContribution,
  type EveNitroContribution,
} from "#internal/nitro/host/eve-nitro-contribution.js";
import { applyEveNitroConfigDelta } from "#internal/nitro/host/merge-eve-nitro-config.js";
import {
  prepareDevelopmentApplicationHost,
  prepareProductionApplicationHost,
} from "#internal/nitro/host/prepare-application-host.js";
import { resolveAuthoredWatchPaths } from "#internal/nitro/host/dev-authored-source-watcher.js";
import {
  startEmbeddedNitroViteDevWatcher,
  type EmbeddedNitroViteDevWatcherHandle,
} from "#internal/nitro/host/embedded-nitro-vite-dev-watcher.js";
import {
  loadFileUrlModule,
  resolveFileUrlModule,
} from "#internal/nitro/host/load-file-url-module.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { computeChannelRouteRegistrations } from "#internal/nitro/host/channel-routes.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  activateDevelopmentGeneration,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { toErrorMessage } from "#shared/errors.js";

const EVE_NITRO_PLUGIN_NAME = "eve:nitro";

/** Configuration for embedding one filesystem-authored eve agent. */
export interface EveNitroOptions {
  /**
   * Agent directory or path used for eve discovery. Relative paths resolve
   * from the Nitro project root. Defaults to `agent`.
   */
  readonly agent?: string;
}

/**
 * A Vite-compatible plugin carrying the Nitro module installed by eve.
 *
 * This eve-owned structural type intentionally does not expose Nitro or Vite
 * types as part of the public API.
 */
export interface EveNitroPlugin {
  readonly name: "eve:nitro";
  readonly nitro: {
    readonly name: "eve:nitro";
    setup(nitro: unknown): Promise<void>;
  };
}

interface EmbeddedViteDevServer {
  close(): Promise<void>;
  readonly environments?: {
    readonly nitro?: {
      readonly hot: {
        send(payload: { readonly type: "full-reload" }): Promise<void> | void;
      };
      readonly moduleGraph: {
        invalidateAll(): void;
      };
    };
  };
  restart(): Promise<void>;
  watcher: Parameters<typeof startEmbeddedNitroViteDevWatcher>[0]["watcher"];
}

interface PreparedEmbeddedDevelopmentLifecycle {
  readonly nitro: Nitro;
  preparedHost: PreparedDevelopmentApplicationHost;
}

interface InternalEveNitroPlugin extends EveNitroPlugin {
  readonly enforce: "post";
  configureServer(server: EmbeddedViteDevServer): Promise<void>;
  load(id: string): Promise<string | undefined>;
  resolveId(id: string, importer?: string): string | undefined;
}

export function resolveEveNitroAgentPath(rootDir: string, agent: string | undefined): string {
  return resolve(rootDir, agent ?? "agent");
}

function createIdempotentCleanup(
  operations: readonly (() => Promise<void>)[],
  message: string,
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return () => {
    cleanup ??= (async () => {
      const results = await Promise.allSettled(operations.map((operation) => operation()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, message);
      }
    })();
    return cleanup;
  };
}

function createDevelopmentCleanup(
  getPreparedHost: () => PreparedDevelopmentApplicationHost,
): () => Promise<void> {
  return createIdempotentCleanup(
    [
      () => discardDevelopmentGeneration(getPreparedHost().generation),
      () => removeDevelopmentHostWorkspace(getPreparedHost().workspace),
    ],
    "Failed to clean up the embedded eve development host.",
  );
}

function createProductionCleanup(workspace: ApplicationBuildWorkspace): () => Promise<void> {
  return createIdempotentCleanup(
    [() => removeApplicationBuildWorkspace(workspace)],
    "Failed to clean up the embedded eve production workspace.",
  );
}

async function cleanUpFailedSetup(
  error: unknown,
  cleanup: (() => Promise<void>) | undefined,
): Promise<never> {
  if (cleanup !== undefined) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to configure and clean up the embedded eve Nitro integration.",
        { cause: error },
      );
    }
  }
  throw error;
}

async function setupEveNitro(
  nitro: Nitro,
  options: EveNitroOptions,
  onDevelopmentReady: (lifecycle: PreparedEmbeddedDevelopmentLifecycle) => void,
): Promise<void> {
  const installation = beginEmbeddedEveNitroInstallation(nitro);
  const agentPath = resolveEveNitroAgentPath(nitro.options.rootDir, options.agent);
  let cleanup: (() => Promise<void>) | undefined;
  let developmentLifecycle: PreparedEmbeddedDevelopmentLifecycle | undefined;

  try {
    let contribution: EveNitroContribution<"development"> | EveNitroContribution<"production">;
    if (nitro.options.dev) {
      const preparedHost = await prepareDevelopmentApplicationHost(nitro.options.rootDir, {
        agentRoot: agentPath,
      });
      const lifecycle = { nitro, preparedHost };
      developmentLifecycle = lifecycle;
      cleanup = createDevelopmentCleanup(() => lifecycle.preparedHost);
      contribution = createEveNitroContribution(preparedHost, {
        host: "embedded",
        mode: "development",
        preset: undefined,
        surface: "all",
      });
    } else {
      const workspace = await createApplicationBuildWorkspace(
        nitro.options.rootDir,
        nitro.options.output.dir,
      );
      cleanup = createProductionCleanup(workspace);
      const preparedHost = await prepareProductionApplicationHost(workspace, {
        agentRoot: agentPath,
      });
      contribution = createEveNitroContribution(preparedHost, {
        host: "embedded",
        mode: "production",
        preset: nitro.options.preset === "vercel" ? "vercel" : undefined,
        surface: "all",
      });
      configureEmbeddedProductionArtifacts({
        compilerArtifactsRoot: workspace.compiler.artifactsDir,
        nitro,
        outputDir: nitro.options.output.dir,
      });
    }

    nitro.hooks.hookOnce("build:before", async () => {
      try {
        validateEmbeddedEveNitroHost(nitro, createEmbeddedEveNitroRequirements(contribution));
        applyEveNitroConfigDelta(nitro, contribution);
        if (contribution.mode === "development") {
          await configureInitialStandaloneDevelopmentEveNitroContribution(nitro, contribution);
        } else {
          await applyProductionEveNitroContribution(nitro, contribution);
        }
        nitro.routing.sync();
        if (developmentLifecycle !== undefined) {
          await activateDevelopmentGeneration({
            appRoot: developmentLifecycle.preparedHost.appRoot,
            generation: developmentLifecycle.preparedHost.generation,
          });
          onDevelopmentReady(developmentLifecycle);
        }
        installation.commit();
      } catch (error) {
        installation.rollback();
        return await cleanUpFailedSetup(error, cleanup);
      }
    });
    nitro.hooks.hookOnce("close", async () => {
      installation.rollback();
      await cleanup?.();
    });
  } catch (error) {
    installation.rollback();
    return await cleanUpFailedSetup(error, cleanup);
  }
}

/**
 * Embeds one filesystem-authored eve agent in an existing Nitro 3 host.
 *
 * Add the returned object to Nitro's `modules` option or to a Vite plugin list
 * alongside `nitro/vite`. Nitro continues to own its listener, project and
 * output directories, deployment preset, and platform policy.
 */
export function eveNitro(options: EveNitroOptions = {}): EveNitroPlugin {
  const developmentLifecycles: PreparedEmbeddedDevelopmentLifecycle[] = [];

  const plugin: InternalEveNitroPlugin = {
    name: EVE_NITRO_PLUGIN_NAME,
    enforce: "post",
    nitro: {
      name: EVE_NITRO_PLUGIN_NAME,
      async setup(input: unknown) {
        await setupEveNitro(input as Nitro, options, (lifecycle) => {
          developmentLifecycles.push(lifecycle);
        });
      },
    },
    load: loadFileUrlModule,
    resolveId: resolveFileUrlModule,
    async configureServer(server) {
      const lifecycle = developmentLifecycles.shift();
      if (lifecycle === undefined) {
        return;
      }

      const watchPaths = await resolveAuthoredWatchPaths(lifecycle.preparedHost);
      const restartHost = server.restart.bind(server);
      let restartDepth = 0;
      let restartCloseObserved = false;
      let embeddedLifecycleClosing = false;
      const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
        initialHost: lifecycle.preparedHost,
        async restartHost() {
          if (embeddedLifecycleClosing) {
            throw new Error("Cannot restart an embedded eve host while it is closing.");
          }
          restartDepth += 1;
          restartCloseObserved = false;
          try {
            await restartHost();
            if (!restartCloseObserved) {
              throw new Error(
                "The host Vite server resolved its restart without replacing the embedded eve lifecycle.",
              );
            }
          } finally {
            restartDepth -= 1;
          }
        },
        async stageRouteTopology({ nextHost, previousHost }) {
          const nitroEnvironment = server.environments?.nitro;
          if (nitroEnvironment === undefined) {
            throw new Error(
              "The host Vite server does not expose its Nitro environment for route reloads.",
            );
          }
          const artifactsConfig = createDevelopmentNitroArtifactsConfig({
            appRoot: previousHost.appRoot,
            configuredWorld:
              previousHost.compileResult.manifest.config.experimental?.workflow?.world,
          });
          const previous = computeChannelRouteRegistrations(previousHost);
          const next = computeChannelRouteRegistrations(nextHost);
          const reload = async () => {
            nitroEnvironment.moduleGraph.invalidateAll();
            await nitroEnvironment.hot.send({ type: "full-reload" });
          };
          return stageEmbeddedRouteTopology({
            artifactsConfig,
            next,
            nitro: lifecycle.nitro,
            previous,
            reload,
          });
        },
      });
      const watcher: EmbeddedNitroViteDevWatcherHandle = await startEmbeddedNitroViteDevWatcher({
        onError(error) {
          lifecycle.nitro.logger.error(
            `[eve:nitro] authored rebuild failed: ${toErrorMessage(error)}`,
          );
        },
        async rebuild(changedPaths) {
          const result = await coordinator.rebuild({ changedPaths });
          if (embeddedLifecycleClosing) {
            return;
          }
          lifecycle.preparedHost = result.host;
          if (result.kind !== "structural") {
            watcher.updateWatchPaths(await resolveAuthoredWatchPaths(result.host));
          }
        },
        watcher: server.watcher,
        watchPaths,
      });

      const closeHost = server.close.bind(server);
      const closeHostResources = createIdempotentCleanup(
        [closeHost, () => lifecycle.nitro.close()],
        "Failed to close the embedded eve Nitro development host resources.",
      );
      const closeEmbeddedHost = createIdempotentCleanup(
        [
          async () => {
            embeddedLifecycleClosing = true;
            await watcher.close();
            await closeHostResources();
          },
        ],
        "Failed to close the embedded eve Nitro development host.",
      );
      const closeEmbeddedHostForRestart = createIdempotentCleanup(
        [
          async () => {
            embeddedLifecycleClosing = true;
            // The restart is running inside this watcher's active rebuild, so
            // awaiting close here would wait on the current call itself.
            watcher.stop();
            await closeHostResources();
          },
        ],
        "Failed to replace the embedded eve Nitro development host.",
      );
      server.close = () => {
        if (restartDepth === 0) {
          return closeEmbeddedHost();
        }
        restartCloseObserved = true;
        return closeEmbeddedHostForRestart();
      };
    },
  };

  return plugin;
}
