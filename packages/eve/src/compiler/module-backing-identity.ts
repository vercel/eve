import { createHash } from "node:crypto";

import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import type { CompiledAgentResources } from "#compiler/manifest.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";

/** Content/generation identity for one selected executable backing. */
export async function createCompiledModuleBackingIdentity(
  backing: CompiledModuleBacking,
  externalDependencyPlan: CompiledExternalDependencyPlan,
): Promise<string> {
  if (backing.kind === "filesystem") {
    return await createFilesystemModuleSemanticHash(backing, externalDependencyPlan);
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: backing.kind,
        moduleId: backing.moduleId,
        registryId: backing.registryId,
        semanticRevision: backing.semanticRevision ?? backing.revision,
      }),
    )
    .digest("hex");
}

export async function createFilesystemModuleSemanticHash(
  backing: Extract<CompiledAgentResources["bindings"][string]["backing"], { kind: "filesystem" }>,
  externalDependencyPlan: CompiledExternalDependencyPlan,
): Promise<string> {
  const { bundleAuthoredModuleForGeneration } = await import("#internal/authored-module-loader.js");
  const externalDependencies = externalDependencyPlanPackageNames(backing.externalDependencies);
  const source = await bundleAuthoredModuleForGeneration(backing.sourcePath, {
    externalDependencies,
    externalDependencyPlan,
    extensionScopeNamespace: backing.extensionScope?.namespace,
  });
  const dependencies = externalDependencies.map((dependencyId) => {
    const entry = externalDependencyPlan.entries.find((candidate) => candidate.id === dependencyId);
    if (entry === undefined) {
      throw new Error(
        `Cannot identify filesystem backing "${backing.sourcePath}" without external dependency plan entry "${dependencyId}".`,
      );
    }
    return {
      id: dependencyId,
      semanticSha256: entry.semanticSha256,
    };
  });
  return createHash("sha256")
    .update(
      JSON.stringify({
        dependencies,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      }),
    )
    .digest("hex");
}
