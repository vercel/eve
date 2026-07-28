import { stageDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { computeDevelopmentHostFingerprints } from "#internal/nitro/host/dev-host-fingerprint.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  activateDevelopmentGeneration,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";

type EmbeddedDevelopmentRebuildKind = "runtime" | "structural" | "unchanged";

interface EmbeddedDevelopmentRebuildResult {
  readonly host: PreparedDevelopmentApplicationHost;
  readonly kind: EmbeddedDevelopmentRebuildKind;
}

interface EmbeddedDevelopmentRebuildCoordinator {
  rebuild(input: {
    readonly changedPaths: readonly string[];
  }): Promise<EmbeddedDevelopmentRebuildResult>;
}

interface EmbeddedRouteTopologyReplacement {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Compiles authored changes beside the live embedded host. Runtime-only
 * changes atomically advance eve's generation pointer without restarting the
 * framework. Structural changes cross the host-owned Vite restart boundary.
 */
export async function createEmbeddedDevelopmentRebuildCoordinator(input: {
  readonly initialHost: PreparedDevelopmentApplicationHost;
  readonly restartHost: () => Promise<void>;
  readonly stageRouteTopology: (input: {
    readonly nextHost: PreparedDevelopmentApplicationHost;
    readonly previousHost: PreparedDevelopmentApplicationHost;
  }) => Promise<EmbeddedRouteTopologyReplacement>;
}): Promise<EmbeddedDevelopmentRebuildCoordinator> {
  const currentFingerprints = await computeDevelopmentHostFingerprints(input.initialHost);
  return new TransactionalEmbeddedDevelopmentRebuildCoordinator({
    currentHostConfigurationFingerprint: currentFingerprints.configuration,
    currentHostFingerprint: currentFingerprints.host,
    currentRuntimeFingerprint: input.initialHost.generation.fingerprint,
    initialHost: input.initialHost,
    restartHost: input.restartHost,
    stageRouteTopology: input.stageRouteTopology,
  });
}

class TransactionalEmbeddedDevelopmentRebuildCoordinator implements EmbeddedDevelopmentRebuildCoordinator {
  #currentHost: PreparedDevelopmentApplicationHost;
  #currentHostConfigurationFingerprint: string;
  #currentHostFingerprint: string;
  #currentRuntimeFingerprint: string;
  readonly #restartHost: () => Promise<void>;
  readonly #stageRouteTopology: (input: {
    readonly nextHost: PreparedDevelopmentApplicationHost;
    readonly previousHost: PreparedDevelopmentApplicationHost;
  }) => Promise<EmbeddedRouteTopologyReplacement>;

  constructor(input: {
    readonly currentHostConfigurationFingerprint: string;
    readonly currentHostFingerprint: string;
    readonly currentRuntimeFingerprint: string;
    readonly initialHost: PreparedDevelopmentApplicationHost;
    readonly restartHost: () => Promise<void>;
    readonly stageRouteTopology: (input: {
      readonly nextHost: PreparedDevelopmentApplicationHost;
      readonly previousHost: PreparedDevelopmentApplicationHost;
    }) => Promise<EmbeddedRouteTopologyReplacement>;
  }) {
    this.#currentHost = input.initialHost;
    this.#currentHostConfigurationFingerprint = input.currentHostConfigurationFingerprint;
    this.#currentHostFingerprint = input.currentHostFingerprint;
    this.#currentRuntimeFingerprint = input.currentRuntimeFingerprint;
    this.#restartHost = input.restartHost;
    this.#stageRouteTopology = input.stageRouteTopology;
  }

  async rebuild(input: {
    readonly changedPaths: readonly string[];
  }): Promise<EmbeddedDevelopmentRebuildResult> {
    const previousHost = this.#currentHost;
    const environmentReload = stageDevelopmentEnvironmentFiles(previousHost.appRoot);
    let nextHost: PreparedDevelopmentApplicationHost | undefined;

    try {
      nextHost = await prepareDevelopmentApplicationHost(previousHost.appRoot, {
        agentRoot: previousHost.compileResult.project.agentRoot,
        changedPaths: input.changedPaths,
        previousExtensions: previousHost.workspaceExtensions,
      });
      const nextFingerprints = await computeDevelopmentHostFingerprints(nextHost);
      const nextHostFingerprint = nextFingerprints.host;
      const nextHostConfigurationFingerprint = nextFingerprints.configuration;
      const nextRuntimeFingerprint = nextHost.generation.fingerprint;
      const hasStructuralChange = nextHostFingerprint !== this.#currentHostFingerprint;
      const hasRuntimeChange = nextRuntimeFingerprint !== this.#currentRuntimeFingerprint;

      if (!hasStructuralChange && !hasRuntimeChange) {
        const committedHost = {
          ...previousHost,
          workspaceExtensions: nextHost.workspaceExtensions,
        };
        await discardPreparedHost(nextHost);
        nextHost = undefined;
        this.#currentHost = committedHost;
        environmentReload.commit();
        return { host: committedHost, kind: "unchanged" };
      }

      if (!hasStructuralChange) {
        await removeDevelopmentHostWorkspace(nextHost.workspace);
        const committedHost = retainActiveHostWorkspace(previousHost, nextHost);
        await activateDevelopmentGeneration({
          appRoot: committedHost.appRoot,
          generation: committedHost.generation,
        });
        this.#currentHost = committedHost;
        this.#currentHostFingerprint = nextHostFingerprint;
        this.#currentRuntimeFingerprint = nextRuntimeFingerprint;
        nextHost = undefined;
        environmentReload.commit();
        return { host: committedHost, kind: "runtime" };
      }

      if (nextHostConfigurationFingerprint === this.#currentHostConfigurationFingerprint) {
        const replacement = await this.#stageRouteTopology({ nextHost, previousHost });
        try {
          await removeDevelopmentHostWorkspace(nextHost.workspace);
          const committedHost = retainActiveHostWorkspace(previousHost, nextHost);
          await activateDevelopmentGeneration({
            appRoot: committedHost.appRoot,
            generation: committedHost.generation,
          });
          await replacement.commit();
          this.#currentHost = committedHost;
          this.#currentHostConfigurationFingerprint = nextHostConfigurationFingerprint;
          this.#currentHostFingerprint = nextHostFingerprint;
          this.#currentRuntimeFingerprint = nextRuntimeFingerprint;
          nextHost = undefined;
          environmentReload.commit();
          return { host: committedHost, kind: "structural" };
        } catch (error) {
          const rollback = await Promise.allSettled([
            replacement.rollback(),
            activateDevelopmentGeneration({
              appRoot: previousHost.appRoot,
              generation: previousHost.generation,
            }),
          ]);
          const rollbackErrors = rollback.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              "Embedded channel topology rollback failed.",
              { cause: error },
            );
          }
          throw error;
        }
      }

      await discardPreparedHost(nextHost);
      nextHost = undefined;
      await this.#restartHost();
      environmentReload.commit();
      return { host: previousHost, kind: "structural" };
    } catch (error) {
      environmentReload.rollback();
      if (nextHost === undefined) {
        throw error;
      }
      throw await discardFailedHost(error, nextHost);
    }
  }
}

function retainActiveHostWorkspace(
  activeHost: PreparedDevelopmentApplicationHost,
  nextHost: PreparedDevelopmentApplicationHost,
): PreparedDevelopmentApplicationHost {
  return {
    ...nextHost,
    compiledArtifacts: activeHost.compiledArtifacts,
    workflowBuildDir: activeHost.workflowBuildDir,
    workspace: activeHost.workspace,
  };
}

async function discardPreparedHost(host: PreparedDevelopmentApplicationHost): Promise<void> {
  const cleanup = await Promise.allSettled([
    discardDevelopmentGeneration(host.generation),
    removeDevelopmentHostWorkspace(host.workspace),
  ]);
  const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to discard embedded development host "${host.workspace.rootDir}".`,
    );
  }
}

async function discardFailedHost(
  cause: unknown,
  host: PreparedDevelopmentApplicationHost,
): Promise<unknown> {
  try {
    await discardPreparedHost(host);
    return cause;
  } catch (cleanupError) {
    return new AggregateError(
      [cause, cleanupError],
      "Embedded development rebuild rollback failed.",
      { cause },
    );
  }
}
