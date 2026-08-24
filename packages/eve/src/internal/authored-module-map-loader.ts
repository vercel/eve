import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { compiledModuleMapSchema, type CompiledModuleMap } from "#compiler/module-map.js";
import { bundleAuthoredModuleMapForGeneration } from "#internal/authored-module-loader.js";
import { materializeCompiledExternalDependencyPlan } from "#internal/materialize-external-dependencies.js";
import { readMaterializedAuthoredModuleIndex } from "#internal/materialized-authored-modules.js";
import type { CompileMetadata } from "#protocol/compile-metadata.js";
import type { CompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import { readCompiledModuleMapIdentity } from "#protocol/compiled-module-map-identity.js";
import {
  assertCompiledModuleMapDescriptorSemantics,
  hydrateCompiledModuleMapDescriptor,
  parseCompiledModuleMapDescriptor,
  validateCompiledModuleMapDescriptorRegistries,
} from "#runtime/loaders/bundled-artifacts.js";

/**
 * Hydrates the exact manifest already validated by the artifact-set loader.
 * Authored-source mode bundles the digest-validated descriptor bytes from the
 * same snapshot; both modes then capture one immutable lazy descriptor,
 * validate its compiler-owned identity and every selected registry binding,
 * and only then execute namespaces. Materialized-generation mode never falls
 * back to live authored source.
 */
export async function loadCompiledModuleMapFromValidatedManifest(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly expectedIdentity: string;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly mode: "authored-source" | "materialized-generation";
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
  readonly runtimeAppRoot: string;
}): Promise<CompiledModuleMap> {
  if (input.mode === "materialized-generation") {
    const materializedIndex = await readMaterializedAuthoredModuleIndex({
      metadata: input.metadata,
      runtimeAppRoot: input.runtimeAppRoot,
    });
    if (materializedIndex === undefined) {
      throw new Error(
        `Expected immutable runtime generation "${input.runtimeAppRoot}" to contain a materialized authored module index.`,
      );
    }
    return await loadCapturedCompiledModuleMapDescriptor({
      diagnostics: input.diagnostics,
      expectedIdentity: input.expectedIdentity,
      manifest: input.manifest,
      metadata: input.metadata,
      moduleMapPath: join(input.runtimeAppRoot, ".eve", "compile", materializedIndex.moduleMap),
      moduleMapSource: materializedIndex.moduleMapCode,
    });
  }

  const capturedDependencies = await materializeCompiledExternalDependencyPlan({
    destinationRoot: join(input.runtimeAppRoot, ".eve", "compile", "runtime-external-dependencies"),
    plan: input.manifest.externalDependencyPlan,
  });
  const bundledModuleMapSource = await bundleAuthoredModuleMapForGeneration({
    expectedIdentity: input.expectedIdentity,
    externalDependencyMode: "resolved-path",
    externalDependencyPlan: capturedDependencies.plan,
    manifest: input.manifest,
    moduleMapPath: resolve(input.manifest.appRoot, input.metadata.compile.moduleMap.path),
    moduleMapSource: input.moduleMapSource,
  });
  return await loadCapturedCompiledModuleMapDescriptor({
    diagnostics: input.diagnostics,
    expectedIdentity: input.expectedIdentity,
    manifest: input.manifest,
    metadata: input.metadata,
    moduleMapPath: input.moduleMapPath,
    moduleMapSource: bundledModuleMapSource,
  });
}

async function loadCapturedCompiledModuleMapDescriptor(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly expectedIdentity: string;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
}): Promise<CompiledModuleMap> {
  const capturedPath = await writePrivateCapturedDescriptor(input);
  try {
    const moduleNamespace = (await import(
      `${pathToFileURL(capturedPath).href}?capture=${encodeURIComponent(capturedPath)}`
    )) as { readonly default?: unknown; readonly moduleMapDescriptor?: unknown };
    const descriptor = parseCompiledModuleMapDescriptor(
      moduleNamespace.moduleMapDescriptor ?? moduleNamespace.default,
    );
    if (descriptor.identity !== input.expectedIdentity) {
      throw new Error(
        `Compiled module map identity mismatch: expected "${input.expectedIdentity}", received "${descriptor.identity}".`,
      );
    }
    assertCompiledModuleMapDescriptorSemantics({
      descriptor,
      diagnostics: input.diagnostics,
      manifest: input.manifest,
      metadata: input.metadata,
    });
    await validateCompiledModuleMapDescriptorRegistries(descriptor);
    const moduleMap = await hydrateCompiledModuleMapDescriptor(descriptor);
    compiledModuleMapSchema.parse(moduleMap);
    const identity = readCompiledModuleMapIdentity(moduleMap);
    if (identity !== input.expectedIdentity) {
      throw new Error(
        `Hydrated compiled module map identity mismatch: expected "${input.expectedIdentity}", received "${identity ?? "none"}".`,
      );
    }
    return moduleMap;
  } finally {
    await rm(capturedPath, { force: true });
  }
}

async function writePrivateCapturedDescriptor(input: {
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
}): Promise<string> {
  const directory = dirname(input.moduleMapPath);
  await mkdir(directory, { recursive: true });
  const digest = createHash("sha256").update(input.moduleMapSource).digest("hex");
  const path = join(directory, `.eve-verified-module-map-${digest}-${randomUUID()}.mjs`);
  await writeFile(path, input.moduleMapSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}
