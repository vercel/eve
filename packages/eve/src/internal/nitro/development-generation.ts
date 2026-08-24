import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import {
  prepareMaterializedAuthoredModules,
  writeMaterializedAuthoredModules,
} from "#internal/materialized-authored-modules.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshotTransaction,
  pruneDevelopmentRuntimeArtifactsSnapshots,
  stageDevelopmentRuntimeArtifactsSnapshot,
  type DevelopmentRuntimeArtifactsActivation,
  type DevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";

export interface DevelopmentGeneration extends DevelopmentRuntimeArtifactsSnapshot {
  readonly fingerprint: string;
}

interface DevelopmentGenerationPruneState {
  requested: boolean;
  running: Promise<void> | undefined;
}

const developmentGenerationPruneStates = new Map<string, DevelopmentGenerationPruneState>();

export async function stageDevelopmentGeneration(
  compileResult: CompileAgentResult,
): Promise<DevelopmentGeneration> {
  const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot(compileResult);

  try {
    const snapshotCompileRoot = join(snapshot.runtimeAppRoot, ".eve", "compile");
    const [moduleMapSource, manifestSource] = await Promise.all([
      readFile(join(snapshotCompileRoot, "module-map.mjs"), "utf8"),
      readFile(join(snapshotCompileRoot, "compiled-agent-manifest.json"), "utf8"),
    ]);
    const expectedModuleMapDigest = compileResult.metadata.compile.moduleMap.sha256;
    const actualModuleMapDigest = createHash("sha256").update(moduleMapSource).digest("hex");
    if (actualModuleMapDigest !== expectedModuleMapDigest) {
      throw new Error(
        `Development generation module-map digest mismatch: expected "${expectedModuleMapDigest}", received "${actualModuleMapDigest}".`,
      );
    }
    const prepared = await prepareMaterializedAuthoredModules({
      descriptorProjection: {
        manifest: parseCompiledAgentManifest(JSON.parse(manifestSource) as unknown),
        runtimeAppRoot: snapshot.runtimeAppRoot,
      },
      expectedIdentity: compileResult.metadata.compile.moduleMap.identitySha256,
      manifest: compileResult.manifest,
      moduleMapPath: resolve(
        compileResult.project.appRoot,
        compileResult.metadata.compile.moduleMap.path,
      ),
      moduleMapSource,
    });
    const materialized = await writeMaterializedAuthoredModules({
      prepared,
      runtimeAppRoot: snapshot.runtimeAppRoot,
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
  const activation = await activateDevelopmentGenerationTransaction(input);
  activation.commit();
}

export async function activateDevelopmentGenerationTransaction(input: {
  readonly appRoot: string;
  readonly generation: DevelopmentGeneration;
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
      requestDevelopmentGenerationPrune(input.appRoot);
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

function requestDevelopmentGenerationPrune(appRoot: string): void {
  const state = developmentGenerationPruneStates.get(appRoot) ?? {
    requested: false,
    running: undefined,
  };
  developmentGenerationPruneStates.set(appRoot, state);
  state.requested = true;
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
      await pruneDevelopmentRuntimeArtifactsSnapshots({ appRoot });
    }
  })()
    .catch((error) => {
      console.warn(`[eve:dev] failed to prune runtime generations: ${String(error)}`);
    })
    .finally(() => {
      state.running = undefined;
      if (state.requested) {
        startDevelopmentGenerationPruning(appRoot, state);
      } else {
        developmentGenerationPruneStates.delete(appRoot);
      }
    });
}
