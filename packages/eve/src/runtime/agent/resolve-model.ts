import type { LanguageModel } from "ai";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import {
  expectObjectRecord,
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import type { ModuleDefinitionExport } from "#public/definitions/source.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledModuleMap } from "#runtime/loaders/module-map.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveBootstrapRuntimeModel } from "#runtime/agent/bootstrap-model.js";
import {
  resolveMockAuthoredRuntimeModel,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/mock-model-adapter.js";

export { shouldMockAuthoredRuntimeModels };

/**
 * Resolves one runtime model reference into the active language model.
 */
export async function resolveRuntimeModelReference(
  reference: RuntimeModelReference,
  input: {
    readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  } = {},
): Promise<LanguageModel> {
  const bootstrapModel = resolveBootstrapRuntimeModel(reference);

  if (bootstrapModel !== null) {
    return bootstrapModel;
  }

  const mockModel = resolveMockAuthoredRuntimeModel(reference);

  if (mockModel !== null) {
    return mockModel;
  }

  if (isSourceBackedRuntimeModelReference(reference)) {
    return await loadSourceBackedRuntimeModelReference(reference, input);
  }

  return reference.id;
}

async function loadSourceBackedRuntimeModelReference(
  reference: RuntimeModelReference & {
    readonly source: NonNullable<RuntimeModelReference["source"]>;
  },
  input: {
    readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  },
): Promise<LanguageModel> {
  if (input.compiledArtifactsSource === undefined) {
    throw new Error(
      `Expected an explicit compiled artifact source to resolve the authored runtime model "${reference.id}".`,
    );
  }

  const moduleMap = await loadCompiledModuleMap({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });
  const moduleNamespace =
    moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[reference.source.sourceId];

  const moduleRecord = expectObjectRecord(
    moduleNamespace,
    `Missing compiled agent config module for runtime model "${reference.id}" at "${reference.source.logicalPath}".`,
  );
  const exportValue = getAuthoredModuleExport(moduleRecord, reference.source);
  const definition = await materializeAuthoredModuleExport(
    exportValue as ModuleDefinitionExport<unknown>,
  );
  const normalizedDefinition = normalizeAgentDefinition(
    definition,
    `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to match the public eve shape.`,
  );
  const model = normalizedDefinition.model;

  if (model === undefined) {
    throw new Error(
      `Expected the authored agent config export "${reference.source.exportName ?? "default"}" from "${reference.source.logicalPath}" to provide a runtime model.`,
    );
  }

  if (typeof model === "string") {
    return model;
  }

  return model as LanguageModel;
}

function isSourceBackedRuntimeModelReference(
  reference: RuntimeModelReference,
): reference is RuntimeModelReference & {
  readonly source: NonNullable<RuntimeModelReference["source"]>;
} {
  return reference.source !== undefined;
}
