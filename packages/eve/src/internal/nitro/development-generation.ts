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
  readonly workflowSourceFingerprint?: string;
}

export async function stageDevelopmentGeneration(
  compileResult: CompileAgentResult,
): Promise<DevelopmentGeneration> {
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
  request(): void;
  close(): Promise<void>;
}
