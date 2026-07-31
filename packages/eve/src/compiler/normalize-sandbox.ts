import { createHash } from "node:crypto";
import { join } from "node:path";

import type { SandboxSourceRef } from "#discover/manifest.js";
import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import {
  bundleAuthoredModuleForGeneration,
  loadAuthoredModuleNamespace,
} from "#internal/authored-module-loader.js";
import { getAuthoredModuleExport } from "#internal/authored-module.js";
import { isSandboxDefinition } from "#public/definitions/sandbox.js";
import { isSandboxTemplate } from "#shared/sandbox-template.js";
import type { ModuleBackedDefinitionLoadOptions } from "#compiler/normalize-helpers.js";

/**
 * Compiles sandbox module metadata without invoking the authored definition.
 *
 * The default export is session-dependent runtime code. Build only validates
 * its brand and discovers named template exports that can be prewarmed safely.
 */
export async function compileSandboxDefinition(
  agentRoot: string,
  source: SandboxSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledSandboxDefinition> {
  const modulePath = join(agentRoot, source.logicalPath);
  const [moduleNamespace, sourceHash] = await Promise.all([
    loadAuthoredModuleNamespace(modulePath, {
      externalDependencies: options.externalDependencies,
    }),
    resolveSandboxSourceHash(modulePath, options),
  ]);
  const definition = getAuthoredModuleExport(moduleNamespace, source);

  if (!isSandboxDefinition(definition)) {
    throw new Error(
      `Expected the sandbox export "${source.exportName ?? "default"}" from "${source.logicalPath}" to be created with defineSandbox((ctx) => sandbox).`,
    );
  }

  const templateEntries = Object.entries(moduleNamespace).filter(
    ([exportName, value]) => exportName !== "default" && isSandboxTemplate(value),
  );
  const exportNamesByTemplate = new Map<unknown, string[]>();
  for (const [exportName, template] of templateEntries) {
    const names = exportNamesByTemplate.get(template) ?? [];
    names.push(exportName);
    exportNamesByTemplate.set(template, names);
  }
  const duplicate = [...exportNamesByTemplate.values()].find((names) => names.length > 1);
  if (duplicate !== undefined) {
    throw new Error(
      `Sandbox template exports ${duplicate.map((name) => `"${name}"`).join(", ")} from ` +
        `"${source.logicalPath}" reference the same template. Create one template value per export.`,
    );
  }
  const templateExports = templateEntries.map(([exportName]) => exportName).sort();

  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    sourceHash,
    sourceId: source.sourceId,
    sourceKind: "module",
    templateExports,
  };
}

async function resolveSandboxSourceHash(
  modulePath: string,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<string> {
  const bundle = await bundleAuthoredModuleForGeneration(modulePath, {
    externalDependencies: options.externalDependencies,
  });
  return createHash("sha256").update(bundle).digest("hex");
}
