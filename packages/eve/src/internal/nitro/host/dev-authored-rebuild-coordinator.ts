import { stageDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import type {
  DevelopmentBuilds,
  DevelopmentBuildSession,
} from "#internal/nitro/host/dev-build-host.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { toErrorMessage } from "#shared/errors.js";
import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import type { DevHostSwitch } from "#internal/nitro/host/dev-host-supervisor.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  activateDevelopmentGeneration,
  createDevelopmentGenerationPruner,
  type DevelopmentGenerationPruner,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";

type DevelopmentRebuildKind = "structural" | "unchanged" | "runtime";

export class PostCommitDevelopmentRebuildError extends Error {
  constructor(cause: unknown) {
    super(
      "The development worker was replaced but its generation failed to activate. The server keeps serving the previous generation; the next rebuild retries activation.",
      { cause },
    );
    this.name = "PostCommitDevelopmentRebuildError";
  }
}

export class DevelopmentWorkflowWorldChangeRequiresRestartError extends Error {
  constructor() {
    super(
      "Changing experimental.workflow.world between the parent-owned local World and a custom World requires restarting eve dev.",
    );
    this.name = "DevelopmentWorkflowWorldChangeRequiresRestartError";
  }
}

export interface DevelopmentRebuildResult {
  readonly host: PreparedDevelopmentApplicationHost;
  readonly kind: DevelopmentRebuildKind;
}

export interface DevelopmentAuthoredRebuildCoordinator {
  rebuild(input: { readonly changedPaths: readonly string[] }): Promise<DevelopmentRebuildResult>;
  close(): Promise<void>;
}

export async function createDevelopmentAuthoredRebuildCoordinator(input: {
  readonly builds: DevelopmentBuilds;
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly devServer: DevHostSwitch;
  readonly initialHost: PreparedDevelopmentApplicationHost;
  readonly onRuntimePruned?: () => Promise<void>;
}): Promise<DevelopmentAuthoredRebuildCoordinator> {
  return new TransactionalDevelopmentAuthoredRebuildCoordinator({
    builds: input.builds,
    currentHostFingerprint: await computeDevelopmentHostFingerprint(input.initialHost),
    developmentExtensions: input.developmentExtensions,
    currentRuntimeFingerprint: input.initialHost.generation.fingerprint,
    devServer: input.devServer,
    initialHost: input.initialHost,
    onRuntimePruned: input.onRuntimePruned,
  });
}

class TransactionalDevelopmentAuthoredRebuildCoordinator implements DevelopmentAuthoredRebuildCoordinator {
  readonly #builds: DevelopmentBuilds;
  #currentHost: PreparedDevelopmentApplicationHost;
  #currentHostFingerprint: string;
  #currentRuntimeFingerprint: string;
  readonly #developmentExtensions: DevelopmentExtensionSelection | undefined;
  readonly #devServer: DevHostSwitch;
  readonly #usesParentWorkflowWorld: boolean;
  readonly #pruner: DevelopmentGenerationPruner;

  constructor(input: {
    readonly builds: DevelopmentBuilds;
    readonly currentHostFingerprint: string;
    readonly currentRuntimeFingerprint: string;
    readonly developmentExtensions: DevelopmentExtensionSelection | undefined;
    readonly devServer: DevHostSwitch;
    readonly initialHost: PreparedDevelopmentApplicationHost;
    readonly onRuntimePruned?: () => Promise<void>;
  }) {
    this.#builds = input.builds;
    this.#currentHost = input.initialHost;
    this.#pruner = createDevelopmentGenerationPruner({
      appRoot: input.initialHost.appRoot,
      onRuntimePruned: input.onRuntimePruned,
    });
    this.#pruner.request();
    this.#currentHostFingerprint = input.currentHostFingerprint;
    this.#developmentExtensions = input.developmentExtensions;
    this.#currentRuntimeFingerprint = input.currentRuntimeFingerprint;
    this.#devServer = input.devServer;
    this.#usesParentWorkflowWorld = usesParentDevelopmentWorkflowWorld(
      input.initialHost.compileResult.manifest.config.experimental?.workflow?.world,
    );
  }

  async close(): Promise<void> {
    await this.#pruner.close();
  }

  async rebuild(input: {
    readonly changedPaths: readonly string[];
  }): Promise<DevelopmentRebuildResult> {
    const previousHost = this.#currentHost;
    const environmentReload = stageDevelopmentEnvironmentFiles(previousHost.appRoot);
    const build = this.#builds.begin();
    let nextHost: PreparedDevelopmentApplicationHost | undefined;

    try {
      nextHost = await build.prepare({
        appRoot: previousHost.appRoot,
        changedPaths: input.changedPaths,
        developmentExtensions: this.#developmentExtensions,
        previousExtensions: previousHost.workspaceExtensions,
      });
      if (
        usesParentDevelopmentWorkflowWorld(
          nextHost.compileResult.manifest.config.experimental?.workflow?.world,
        ) !== this.#usesParentWorkflowWorld
      ) {
        throw new DevelopmentWorkflowWorldChangeRequiresRestartError();
      }
      const nextHostFingerprint = await computeDevelopmentHostFingerprint(nextHost);
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
        this.#commitState(
          committedHost,
          this.#currentHostFingerprint,
          this.#currentRuntimeFingerprint,
        );
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
        this.#pruner.request();
        this.#commitState(committedHost, nextHostFingerprint, nextRuntimeFingerprint);
        nextHost = undefined;
        environmentReload.commit();
        await this.#recycleWorker();
        return { host: committedHost, kind: "runtime" };
      }

      const result = await this.#commitStructuralHost({
        build,
        hasRuntimeChange,
        nextHost,
        nextHostFingerprint,
        nextRuntimeFingerprint,
      });
      nextHost = undefined;
      environmentReload.commit();
      this.#devServer.prepareSpare();
      return result;
    } catch (error) {
      if (error instanceof PostCommitDevelopmentRebuildError) {
        environmentReload.commit();
        throw error;
      }
      environmentReload.rollback();
      if (nextHost === undefined) {
        throw error;
      }
      throw await discardFailedHost(error, nextHost);
    } finally {
      build.close();
    }
  }

  async #recycleWorker(): Promise<void> {
    try {
      await this.#devServer.recycle();
    } catch (error) {
      console.warn(
        `[eve:dev] could not start a fresh dev worker; the current worker keeps serving: ${toErrorMessage(error)}`,
      );
    }
    this.#devServer.prepareSpare();
  }

  async #commitStructuralHost(input: {
    readonly build: DevelopmentBuildSession;
    readonly hasRuntimeChange: boolean;
    readonly nextHost: PreparedDevelopmentApplicationHost;
    readonly nextHostFingerprint: string;
    readonly nextRuntimeFingerprint: string;
  }): Promise<DevelopmentRebuildResult> {
    let committedHost = input.nextHost;

    if (!input.hasRuntimeChange) {
      await discardDevelopmentGeneration(input.nextHost.generation);
      committedHost = {
        ...input.nextHost,
        generation: this.#currentHost.generation,
      };
    }

    const payload = await input.build.buildHost(committedHost);

    const workspace = committedHost.workspace;
    await this.#devServer.swapTo({
      dispose: async () => await removeDevelopmentHostWorkspace(workspace),
      entry: payload.entry,
      workerData: payload.workerData,
    });
    if (input.hasRuntimeChange) {
      try {
        await activateDevelopmentGeneration({
          appRoot: committedHost.appRoot,
          generation: committedHost.generation,
        });
        this.#pruner.request();
      } catch (error) {
        await discardDevelopmentGeneration(committedHost.generation).catch(() => undefined);
        this.#commitState(
          { ...committedHost, generation: this.#currentHost.generation },
          input.nextHostFingerprint,
          this.#currentRuntimeFingerprint,
        );
        throw new PostCommitDevelopmentRebuildError(error);
      }
    }

    this.#commitState(
      committedHost,
      input.nextHostFingerprint,
      input.hasRuntimeChange ? input.nextRuntimeFingerprint : this.#currentRuntimeFingerprint,
    );
    return { host: committedHost, kind: "structural" };
  }

  #commitState(
    host: PreparedDevelopmentApplicationHost,
    hostFingerprint: string,
    runtimeFingerprint: string,
  ): void {
    this.#currentHost = host;
    this.#currentHostFingerprint = hostFingerprint;
    this.#currentRuntimeFingerprint = runtimeFingerprint;
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
      `Failed to discard development host "${host.workspace.rootDir}".`,
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
    return new AggregateError([cause, cleanupError], "Development rebuild rollback failed.", {
      cause,
    });
  }
}
