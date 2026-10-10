import { stageDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { createDevelopmentApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { buildDevelopmentHostCandidate } from "#internal/nitro/host/dev-host-candidate.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  activateDevelopmentGeneration,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";

type DevelopmentRebuildKind = "structural" | "unchanged" | "runtime";

/**
 * Raised when generation activation fails after the replacement worker has
 * already been swapped in. The server keeps serving on the new worker with
 * the previous generation; the next rebuild retries activation.
 */
export class PostCommitDevelopmentRebuildError extends Error {
  constructor(cause: unknown) {
    super(
      "The development worker was replaced but its generation failed to activate. The server keeps serving the previous generation; the next rebuild retries activation.",
      { cause },
    );
    this.name = "PostCommitDevelopmentRebuildError";
  }
}

/**
 * Raised when an authored reload changes which process owns the Workflow
 * World. That ownership is fixed when the development server starts, so the
 * existing server must keep serving until the user restarts it.
 */
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
}

export async function createDevelopmentAuthoredRebuildCoordinator(input: {
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly devServer: DrainedNitroDevServer;
  readonly initialHost: PreparedDevelopmentApplicationHost;
  readonly onRuntimePruned?: () => Promise<void>;
}): Promise<DevelopmentAuthoredRebuildCoordinator> {
  return new TransactionalDevelopmentAuthoredRebuildCoordinator({
    currentHostFingerprint: await computeDevelopmentHostFingerprint(input.initialHost),
    developmentExtensions: input.developmentExtensions,
    currentRuntimeFingerprint: input.initialHost.generation.fingerprint,
    devServer: input.devServer,
    initialHost: input.initialHost,
    onRuntimePruned: input.onRuntimePruned,
  });
}

/**
 * Serializes authored rebuilds into a transaction whose commit order makes
 * rollback unnecessary: a candidate generation and worker are prepared while
 * the previous worker keeps serving, the ready worker is swapped in first,
 * and the generation pointer is activated second. Workers are
 * generation-neutral (they load authored modules through the pointer), so
 * every intermediate state serves consistent code, and any failure before
 * the swap simply discards the candidate. Failures after the swap must
 * never travel the discard path — see {@link PostCommitDevelopmentRebuildError}.
 */
class TransactionalDevelopmentAuthoredRebuildCoordinator implements DevelopmentAuthoredRebuildCoordinator {
  #currentHost: PreparedDevelopmentApplicationHost;
  #currentHostFingerprint: string;
  #currentRuntimeFingerprint: string;
  readonly #developmentExtensions: DevelopmentExtensionSelection | undefined;
  readonly #devServer: DrainedNitroDevServer;
  readonly #usesParentWorkflowWorld: boolean;
  readonly #onRuntimePruned: (() => Promise<void>) | undefined;

  constructor(input: {
    readonly currentHostFingerprint: string;
    readonly currentRuntimeFingerprint: string;
    readonly developmentExtensions: DevelopmentExtensionSelection | undefined;
    readonly devServer: DrainedNitroDevServer;
    readonly initialHost: PreparedDevelopmentApplicationHost;
    readonly onRuntimePruned?: () => Promise<void>;
  }) {
    this.#currentHost = input.initialHost;
    this.#onRuntimePruned = input.onRuntimePruned;
    this.#currentHostFingerprint = input.currentHostFingerprint;
    this.#developmentExtensions = input.developmentExtensions;
    this.#currentRuntimeFingerprint = input.currentRuntimeFingerprint;
    this.#devServer = input.devServer;
    this.#usesParentWorkflowWorld = usesParentDevelopmentWorkflowWorld(
      input.initialHost.compileResult.manifest.config.experimental?.workflow?.world,
    );
  }

  async rebuild(input: {
    readonly changedPaths: readonly string[];
  }): Promise<DevelopmentRebuildResult> {
    const previousHost = this.#currentHost;
    // Staged unconditionally rather than keyed off changedPaths: a failed
    // rebuild rolls the environment back, and the paths that carried the env
    // edit are consumed by that attempt — a later retry would otherwise
    // commit without ever reapplying the change.
    const environmentReload = stageDevelopmentEnvironmentFiles(previousHost.appRoot);
    let nextHost: PreparedDevelopmentApplicationHost | undefined;

    try {
      nextHost = await prepareDevelopmentApplicationHost(previousHost.appRoot, {
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
          onRuntimePruned: this.#onRuntimePruned,
        });
        this.#commitState(committedHost, nextHostFingerprint, nextRuntimeFingerprint);
        nextHost = undefined;
        environmentReload.commit();
        return { host: committedHost, kind: "runtime" };
      }

      const result = await this.#commitStructuralHost({
        hasRuntimeChange,
        nextHost,
        nextHostFingerprint,
        nextRuntimeFingerprint,
      });
      nextHost = undefined;
      environmentReload.commit();
      return result;
    } catch (error) {
      if (error instanceof PostCommitDevelopmentRebuildError) {
        // The swapped worker is live and was spawned with the staged
        // environment; only the pointer activation failed.
        environmentReload.commit();
        throw error;
      }
      environmentReload.rollback();
      if (nextHost === undefined) {
        throw error;
      }
      throw await discardFailedHost(error, nextHost);
    }
  }

  async #commitStructuralHost(input: {
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

    const nitro = await createDevelopmentApplicationNitro(committedHost);
    const payload = await buildDevelopmentHostCandidate({ host: committedHost, nitro });

    // Worker first, pointer second: a failed candidate leaves both the
    // previous worker and the previous pointer untouched, and the
    // just-swapped worker serves the previous generation correctly for the
    // instant before activation because hosts are generation-neutral.
    const workspace = committedHost.workspace;
    await this.#devServer.replaceWorker({
      dispose: async () => await removeDevelopmentHostWorkspace(workspace),
      entry: payload.entry,
      workerData: payload.workerData,
    });
    // The worker swap is the transaction's commit point: the retired worker
    // is already draining, so a failure past this line must not discard the
    // live host through the candidate-rollback path. A failed activation
    // keeps the swapped worker serving the previous generation and leaves
    // the runtime fingerprint stale so the next rebuild retries activation.
    if (input.hasRuntimeChange) {
      try {
        await activateDevelopmentGeneration({
          appRoot: committedHost.appRoot,
          generation: committedHost.generation,
          onRuntimePruned: this.#onRuntimePruned,
        });
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
