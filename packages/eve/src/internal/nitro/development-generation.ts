import { rm } from "node:fs/promises";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { materializeAuthoredModules } from "#internal/materialized-authored-modules.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  activateDevelopmentRuntimeArtifactsSnapshotTransaction,
  stageDevelopmentRuntimeArtifactsSnapshot,
  type DevelopmentRuntimeArtifactsActivation,
  type DevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";

export interface DevelopmentGeneration extends DevelopmentRuntimeArtifactsSnapshot {
  readonly fingerprint: string;
}

export async function stageDevelopmentGeneration(
  compileResult: CompileAgentResult,
): Promise<DevelopmentGeneration> {
  const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot(compileResult);

  try {
    const materialized = await materializeAuthoredModules({
      appRoot: compileResult.project.appRoot,
      runtimeAppRoot: snapshot.runtimeAppRoot,
      snapshotSourceRoot: snapshot.snapshotSourceRoot,
      sourceRoot: snapshot.sourceRoot,
    });

    return {
      ...snapshot,
      fingerprint: materialized.fingerprint,
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

export async function publishDevelopmentGeneration(
  compileResult: CompileAgentResult,
): Promise<DevelopmentGeneration> {
  const generation = await stageDevelopmentGeneration(compileResult);
  await activateDevelopmentGeneration({
    appRoot: compileResult.project.appRoot,
    generation,
  });
  return generation;
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

export async function activateDevelopmentGenerationTransaction(input: {
  readonly appRoot: string;
  readonly generation: DevelopmentGeneration;
}): Promise<DevelopmentRuntimeArtifactsActivation> {
  return await activateDevelopmentRuntimeArtifactsSnapshotTransaction({
    appRoot: input.appRoot,
    snapshot: input.generation,
  });
}

export async function discardDevelopmentGeneration(
  generation: DevelopmentGeneration,
): Promise<void> {
  await rm(generation.snapshotRoot, { force: true, recursive: true });
}
