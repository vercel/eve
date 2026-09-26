import { rm } from "node:fs/promises";
import { finalizeDevelopmentGenerationMetadata } from "#internal/nitro/dev-runtime-generation-metadata.js";
import { getDevelopmentFrameworkFingerprint } from "#internal/workflow/development-runtime-compatibility.js";

import type { AuthoredWorkflowModules } from "#internal/workflow-bundle/builder-support.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { prepareAuthoredRuntimeModules } from "#internal/authored-runtime-modules.js";
import { writeMaterializedAuthoredModules } from "#internal/materialized-authored-modules.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshotTransaction,
  pruneDevelopmentRuntimeArtifactsSnapshots,
  stageDevelopmentRuntimeArtifactsSnapshot,
  type DevelopmentRuntimeArtifactsActivation,
  type DevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";

export interface DevelopmentGeneration extends DevelopmentRuntimeArtifactsSnapshot {
  readonly authoredWorkflowModules?: AuthoredWorkflowModules;
  readonly fingerprint: string;
  /** Identity of the authored sources the workflow driver and step registrations are built from. */
  readonly workflowSourceFingerprint?: string;
}

interface DevelopmentGenerationPruneState {
  requested: boolean;
  reconciliationPending: boolean;
  running: Promise<void> | undefined;
  onRuntimePruned?: () => Promise<void>;
}

const developmentGenerationPruneStates = new Map<string, DevelopmentGenerationPruneState>();

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

    await finalizeDevelopmentGenerationMetadata(snapshot.snapshotRoot, {
      runtimeAppRoot: snapshot.runtimeAppRoot,
      frameworkFingerprint: await getDevelopmentFrameworkFingerprint(),
      workflowSourceFingerprint: prepared.workflowSourceFingerprint,
    });

    return prepared.workflowSourceFingerprint === undefined
      ? {
          ...snapshot,
          authoredWorkflowModules: prepared.authoredWorkflowModules,
          fingerprint: materialized.fingerprint,
        }
      : {
          ...snapshot,
          authoredWorkflowModules: prepared.authoredWorkflowModules,
          fingerprint: materialized.fingerprint,
          workflowSourceFingerprint: prepared.workflowSourceFingerprint,
        };
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

export async function activateDevelopmentGeneration(input: {
  readonly appRoot: string;
  readonly generation: DevelopmentGeneration;
  readonly onRuntimePruned?: () => Promise<void>;
}): Promise<void> {
  const activation = await activateDevelopmentGenerationTransaction(input);
  activation.commit();
}

export async function activateDevelopmentGenerationTransaction(input: {
  readonly appRoot: string;
  readonly generation: DevelopmentGeneration;
  readonly onRuntimePruned?: () => Promise<void>;
}): Promise<DevelopmentRuntimeArtifactsActivation> {
  const activation = await activateDevelopmentRuntimeArtifactsSnapshotTransaction({
    appRoot: input.appRoot,
    snapshot: input.generation,
  });
  let settled = false;
  return {
    commit() {
      if (settled) {
        return;
      }
      settled = true;
      activation.commit();
      requestDevelopmentGenerationPrune(input.appRoot, input.onRuntimePruned);
    },
    async rollback() {
      if (settled) {
        return;
      }
      settled = true;
      await activation.rollback();
    },
  };
}

export async function discardDevelopmentGeneration(
  generation: DevelopmentGeneration,
): Promise<void> {
  await rm(generation.snapshotRoot, { force: true, recursive: true });
}

function requestDevelopmentGenerationPrune(
  appRoot: string,
  onRuntimePruned: (() => Promise<void>) | undefined,
): void {
  const state: DevelopmentGenerationPruneState = developmentGenerationPruneStates.get(appRoot) ?? {
    requested: false,
    reconciliationPending: false,
    running: undefined,
  };
  developmentGenerationPruneStates.set(appRoot, state);
  state.requested = true;
  state.onRuntimePruned = onRuntimePruned;
  if (state.running === undefined) {
    startDevelopmentGenerationPruning(appRoot, state);
  }
}

function startDevelopmentGenerationPruning(
  appRoot: string,
  state: DevelopmentGenerationPruneState,
): void {
  state.running = (async () => {
    while (state.requested) {
      state.requested = false;
      const onRuntimePruned = state.onRuntimePruned;
      let removedSnapshots: boolean;
      try {
        removedSnapshots = await pruneDevelopmentRuntimeArtifactsSnapshots({ appRoot });
      } catch (error) {
        // A failed prune may already have removed some snapshots.
        state.reconciliationPending ||= onRuntimePruned !== undefined;
        throw error;
      }
      state.reconciliationPending ||= removedSnapshots && onRuntimePruned !== undefined;
      try {
        if (state.reconciliationPending && onRuntimePruned !== undefined) {
          await onRuntimePruned();
          state.reconciliationPending = false;
        }
      } catch (error) {
        console.warn(`[eve:dev] failed to reconcile expired Workflow runs: ${String(error)}`);
      }
    }
  })()
    .catch((error) => {
      console.warn(`[eve:dev] failed to prune runtime generations: ${String(error)}`);
    })
    .finally(() => {
      state.running = undefined;
      if (state.requested) {
        startDevelopmentGenerationPruning(appRoot, state);
      } else if (!state.reconciliationPending) {
        developmentGenerationPruneStates.delete(appRoot);
      } else {
        // Retry failed cleanup on the next activation, even if its prune is a no-op.
        state.onRuntimePruned = undefined;
      }
    });
}
