import { rm } from "node:fs/promises";

import type { AuthoredWorkflowModules } from "#internal/workflow-bundle/builder-support.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { prepareAuthoredRuntimeModules } from "#internal/authored-runtime-modules.js";
import { writeMaterializedAuthoredModules } from "#internal/materialized-authored-modules.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  pruneDevelopmentRuntimeArtifactsSnapshots,
  stageDevelopmentRuntimeArtifactsSnapshot,
  type DevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

export interface DevelopmentGeneration extends DevelopmentRuntimeArtifactsSnapshot {
  readonly authoredWorkflowModules?: AuthoredWorkflowModules;
  readonly fingerprint: string;
  /** Identity of the authored sources the workflow driver and step registrations are built from. */
  readonly workflowSourceFingerprint?: string;
}

export async function stageDevelopmentGeneration(
  compileResult: CompileAgentResult,
): Promise<DevelopmentGeneration> {
  // Drain both operations before discarding a failed candidate's snapshot.
  const [preparation, staging] = await Promise.allSettled([
    prepareAuthoredRuntimeModules({
      appRoot: compileResult.project.appRoot,
      manifest: compileResult.manifest,
      moduleMapPath: compileResult.paths.moduleMapPath,
    }),
    stageDevelopmentRuntimeArtifactsSnapshot(compileResult),
  ]);
  if (staging.status === "rejected") {
    if (preparation.status === "rejected") {
      throw new AggregateError(
        [preparation.reason, staging.reason],
        "Failed to stage development generation.",
      );
    }
    throw staging.reason;
  }
  const snapshot = staging.value;

  try {
    if (preparation.status === "rejected") throw preparation.reason;
    const prepared = preparation.value;
    const materialized = await writeMaterializedAuthoredModules({
      prepared,
      runtimeAppRoot: snapshot.runtimeAppRoot,
    });

    const generation = {
      ...snapshot,
      authoredWorkflowModules: prepared.authoredWorkflowModules,
      fingerprint: materialized.fingerprint,
      // The watcher covers the agent root; shared modules imported from elsewhere
      // in the package, such as a workspace's root lib/, need their own entries.
      sourceWatchPaths: [
        ...(snapshot.sourceWatchPaths ?? []),
        ...prepared.sourceModules.filter(
          (path) => !isPathInsideOrEqual(path, compileResult.manifest.agentRoot),
        ),
      ],
    };
    return prepared.workflowSourceFingerprint === undefined
      ? generation
      : { ...generation, workflowSourceFingerprint: prepared.workflowSourceFingerprint };
  } catch (error) {
    try {
      await rm(snapshot.snapshotRoot, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to materialize and discard development generation "${snapshot.snapshotRoot}".`,
      );
    }
    throw error;
  }
}

/** Moves the dev runtime pointer so new sessions load `generation`. */
export async function activateDevelopmentGeneration(input: {
  readonly appRoot: string;
  readonly generation: DevelopmentGeneration;
}): Promise<void> {
  await activateDevelopmentRuntimeArtifactsSnapshot({
    appRoot: input.appRoot,
    snapshot: input.generation,
  });
}

export async function discardDevelopmentGeneration(
  generation: DevelopmentGeneration,
): Promise<void> {
  await rm(generation.snapshotRoot, { force: true, recursive: true });
}

/**
 * Creates a serial queue that prunes retired generations in the background.
 * Requests made while a prune runs coalesce into one more pass. When a pass
 * removes snapshots, `onRuntimePruned` reconciles the Workflow runs they
 * owned; a failed reconciliation, or a failed prune that may have removed
 * some, is retried after the next pass even if that pass removes nothing.
 * `close()` drops pending requests and resolves once the running pass ends.
 */
export function createDevelopmentGenerationPruner(input: {
  readonly appRoot: string;
  readonly onRuntimePruned?: () => Promise<void>;
}): DevelopmentGenerationPruner {
  let requested = false;
  let closed = false;
  let running: Promise<void> | undefined;
  let reconciliationPending = false;

  const run = async (): Promise<void> => {
    while (requested && !closed) {
      requested = false;
      try {
        const removed = await pruneDevelopmentRuntimeArtifactsSnapshots({ appRoot: input.appRoot });
        reconciliationPending ||= removed;
      } catch (error) {
        reconciliationPending = true;
        console.warn(`[eve:dev] failed to prune runtime generations: ${String(error)}`);
        continue;
      }
      if (reconciliationPending && input.onRuntimePruned !== undefined) {
        try {
          await input.onRuntimePruned();
          reconciliationPending = false;
        } catch (error) {
          console.warn(`[eve:dev] failed to reconcile expired Workflow runs: ${String(error)}`);
        }
      }
    }
    running = undefined;
  };

  return {
    request() {
      if (closed) return;
      requested = true;
      running ??= run();
    },
    async close() {
      closed = true;
      await running;
    },
  };
}

export interface DevelopmentGenerationPruner {
  /** Requests a pass; ignored once closed. */
  request(): void;
  close(): Promise<void>;
}
