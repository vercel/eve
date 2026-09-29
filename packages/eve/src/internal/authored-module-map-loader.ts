import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { memoizeModuleNamespaceFactories } from "#compiler/source-graph.js";
import {
  collectRuntimeModuleBindingsForManifest,
  compiledModuleMapSchema,
  resolveExtensionBindingMountId,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import { loadFrameworkProgrammaticModule } from "#framework/sources/registry.js";
import {
  bundleAuthoredModuleMapForGeneration,
  loadAuthoredModuleNamespace,
} from "#internal/authored-module-loader.js";
import { readMaterializedAuthoredModuleIndex } from "#internal/materialized-authored-modules.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { formatValidationError } from "#runtime/validation.js";

/** Hydrates the compiled module map from the manifest’s authored bindings. */
export async function loadCompiledModuleMapFromAuthoredSource(input: {
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
  /** Current location of a built application deployed with its source and dependencies. */
  readonly authoredAppRoot?: string;
}): Promise<CompiledModuleMap> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });
  return await hydrateCompiledModuleMapFromManifest(
    manifest,
    input.compiledArtifactsSource.appRoot,
    input.authoredAppRoot,
  );
}

async function hydrateCompiledModuleMapFromManifest(
  manifest: CompiledAgentManifest,
  runtimeAppRoot: string,
  authoredAppRoot: string = manifest.appRoot,
): Promise<CompiledModuleMap> {
  const materializedIndex = await readMaterializedAuthoredModuleIndex(runtimeAppRoot);
  if (materializedIndex !== undefined) {
    return await loadMaterializedCompiledModuleMap({
      moduleMapPath: materializedIndex.moduleMap,
      runtimeAppRoot,
    });
  }

  if (
    [manifest, ...manifest.subagents.map((subagent) => subagent.agent)].some(
      (node) => node.extensionMounts.length > 0,
    )
  ) {
    const moduleMapPath = join(runtimeAppRoot, ".eve", "compile", "authored-module-map.mjs");
    const { code } = await bundleAuthoredModuleMapForGeneration({
      appRoot: authoredAppRoot,
      manifest,
      moduleMapPath,
      resolveExternalPaths: true,
    });
    const hash = createHash("sha256").update(code).digest("hex");
    const fileName = `authored-module-map-${hash}.mjs`;
    const outputPath = join(runtimeAppRoot, ".eve", "compile", fileName);
    await mkdir(join(runtimeAppRoot, ".eve", "compile"), { recursive: true });
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, code, { flag: "wx" });
      try {
        await link(temporaryPath, outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    // Independent application loads need fresh mutable extension handles, but share bundle bytes.
    return await loadMaterializedCompiledModuleMap({
      moduleMapPath: fileName,
      runtimeAppRoot,
      instanceId: randomUUID(),
    });
  }

  const nodes: CompiledModuleMap["nodes"] = {};
  const nodeManifests: ReadonlyArray<{
    readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
    readonly nodeId: string;
  }> = [
    { manifest, nodeId: ROOT_COMPILED_AGENT_NODE_ID },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({ manifest: subagent.agent, nodeId: subagent.nodeId })),
  ];
  for (const node of nodeManifests) {
    nodes[node.nodeId] = {
      modules: await hydrateCompiledNodeScope(node.manifest, (sourcePath) =>
        resolve(authoredAppRoot, relative(manifest.appRoot, sourcePath)),
      ),
    };
  }
  return { nodes };
}

async function hydrateCompiledNodeScope(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
  resolveSourcePath: (sourcePath: string) => string,
): Promise<CompiledModuleMap["nodes"][string]["modules"]> {
  const modules: CompiledModuleMap["nodes"][string]["modules"] = {};
  for (const { binding, sourceId } of collectRuntimeModuleBindingsForManifest(manifest)) {
    modules[sourceId] =
      binding.backing.kind === "programmatic"
        ? await loadFrameworkProgrammaticModule(
            binding.backing,
            Object.fromEntries(
              Object.entries(binding.backing.dependencies ?? {}).map(
                ([alias, dependencySourceId]) => [alias, modules[dependencySourceId]!],
              ),
            ),
          )
        : memoizeModuleNamespaceFactories(
            await loadAuthoredModuleNamespace(resolveSourcePath(binding.backing.sourcePath), {
              externalDependencies: binding.backing.externalDependencies,
              extension: (() => {
                const mountId = resolveExtensionBindingMountId(binding);
                return mountId === undefined ? undefined : { mountId };
              })(),
            }),
          );
  }
  return modules;
}

async function loadMaterializedCompiledModuleMap(input: {
  readonly instanceId?: string;
  readonly moduleMapPath: string;
  readonly runtimeAppRoot: string;
}): Promise<CompiledModuleMap> {
  const moduleMapPath = join(input.runtimeAppRoot, ".eve", "compile", input.moduleMapPath);
  const moduleNamespace = (await import(
    `${pathToFileURL(moduleMapPath).href}?generation=${encodeURIComponent(input.instanceId ?? input.moduleMapPath)}`
  )) as { readonly default?: unknown; readonly moduleMap?: unknown };
  const parsed = compiledModuleMapSchema.safeParse(
    moduleNamespace.moduleMap ?? moduleNamespace.default,
  );
  if (!parsed.success) {
    throw new Error(
      `Expected materialized authored module map "${moduleMapPath}" to export a valid compiled eve module map. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
