import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import { normalizeMemoryDefinition } from "#internal/authored-definition/memory.js";
import { createMemoryToolDynamicDefinition } from "#context/memory-tools.js";
import type { ProgrammaticModuleLoadContext } from "#compiler/source-graph.js";

export async function loadMemoryWrapperNamespace(
  context: ProgrammaticModuleLoadContext,
): Promise<Readonly<Record<string, unknown>>> {
  const slot = context.parameters.slot;
  const logicalPath = context.parameters.memoryLogicalPath;
  const exportName = context.parameters.memoryExportName;
  const dependency = context.dependencies.memory;
  if (
    typeof slot !== "string" ||
    typeof logicalPath !== "string" ||
    typeof exportName !== "string" ||
    dependency === undefined
  ) {
    throw new Error("The compiled memory wrapper binding is missing its selected memory source.");
  }
  const value = await materializeAuthoredModuleExport(
    getAuthoredModuleExport(dependency, { exportName, logicalPath }),
  );
  const definition = normalizeMemoryDefinition(
    value,
    `Expected the memory export "${exportName}" from "${logicalPath}" to be created with defineMemory().`,
  );
  return { default: createMemoryToolDynamicDefinition(definition, slot) };
}
