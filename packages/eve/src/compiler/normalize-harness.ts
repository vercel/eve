import type { CompiledHarnessDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { harnessOf } from "#public/definitions/harness.js";

/** Checks that `agent/harness.ts` exports a `defineHarness()`; the runtime loads its function. */
export async function compileHarnessDefinition(
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledHarnessDefinition> {
  const loaded = await loadModuleBackedDefinition({
    binding: options.binding,
    kind: "harness",
    loadNamespace: options.loadNamespace,
    source,
  });
  if (harnessOf(loaded) === undefined) {
    throw new Error(
      `Export defineHarness((ctx) => ({ ... })) from "${source.logicalPath}". It exports something else.`,
    );
  }
  return {
    ...(source.exportName !== undefined && { exportName: source.exportName }),
    logicalPath: source.logicalPath,
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
