import { isAbsolute, relative, resolve, sep } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import { collectCompiledModuleScopes } from "#compiler/module-scope.js";

const RUNTIME_RELATIVE_PATH = "__eveRuntimeRelativePath";

export interface GenerationModuleMapDescriptorProjection {
  readonly manifest: CompiledAgentManifest;
  readonly runtimeAppRoot: string;
}

export interface GenerationModuleMapBundleEntry {
  readonly inputPath: string;
  readonly plugin: Record<string, unknown>;
}

/**
 * Keeps compiler-authenticated loader closures pointed at their authored
 * sources while projecting the inert backing metadata of a relocated runtime
 * snapshot. The projection is part of the same single-file bundle, so no
 * executable sidecar can run before artifact preflight.
 */
export function createGenerationModuleMapBundleEntry(input: {
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
  readonly projection?: GenerationModuleMapDescriptorProjection;
  readonly sourceManifest: CompiledAgentManifest;
}): GenerationModuleMapBundleEntry {
  const entryPath =
    input.projection === undefined
      ? input.moduleMapPath
      : `${input.moduleMapPath}.eve-generation-entry.mjs`;
  const entrySource =
    input.projection === undefined
      ? input.moduleMapSource
      : createProjectionEntrySource({
          moduleMapPath: input.moduleMapPath,
          projection: input.projection,
          sourceManifest: input.sourceManifest,
        });

  return {
    inputPath: entryPath,
    plugin: {
      name: "eve-generation-module-map",
      resolveId(id: string) {
        return id === entryPath || id === input.moduleMapPath ? id : undefined;
      },
      load(id: string) {
        if (id === entryPath) return { code: entrySource, moduleType: "js" as const };
        if (id === input.moduleMapPath) {
          return { code: input.moduleMapSource, moduleType: "js" as const };
        }
        return undefined;
      },
    },
  };
}

function createProjectionEntrySource(input: {
  readonly moduleMapPath: string;
  readonly projection: GenerationModuleMapDescriptorProjection;
  readonly sourceManifest: CompiledAgentManifest;
}): string {
  const backings = createGenerationModuleMapBackingProjection({
    projectedManifest: input.projection.manifest,
    runtimeAppRoot: input.projection.runtimeAppRoot,
    sourceManifest: input.sourceManifest,
  });

  return [
    `import sourceDescriptor from ${JSON.stringify(input.moduleMapPath)};`,
    'import { resolve as resolvePath } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    `const backingProjections = ${JSON.stringify(backings)};`,
    "",
    "function hydrateProjection(value, runtimeAppRoot) {",
    '  if (value === null || typeof value !== "object") return value;',
    "  if (",
    "    !Array.isArray(value) &&",
    `    Object.keys(value).length === 1 && typeof value[${JSON.stringify(RUNTIME_RELATIVE_PATH)}] === "string"`,
    "  ) {",
    `    return resolvePath(runtimeAppRoot, value[${JSON.stringify(RUNTIME_RELATIVE_PATH)}]);`,
    "  }",
    "  if (Array.isArray(value)) {",
    "    return value.map((entry) => hydrateProjection(entry, runtimeAppRoot));",
    "  }",
    "  return Object.fromEntries(",
    "    Object.entries(value).map(([key, entry]) => [",
    "      key,",
    "      hydrateProjection(entry, runtimeAppRoot),",
    "    ]),",
    "  );",
    "}",
    "",
    "export function createModuleMapDescriptor(runtimeAppRoot) {",
    "  const nodes = Object.freeze(",
    "    Object.fromEntries(",
    "      Object.entries(sourceDescriptor.nodes).map(([nodeId, scope]) => [",
    "        nodeId,",
    "        Object.freeze({",
    "          modules: Object.freeze(",
    "            Object.fromEntries(",
    "              Object.entries(scope.modules).map(([sourceId, loader]) => [",
    "                sourceId,",
    "                Object.freeze({",
    "                  ...loader,",
    "                  backing: hydrateProjection(",
    "                    backingProjections[nodeId]?.[sourceId],",
    "                    runtimeAppRoot,",
    "                  ),",
    "                }),",
    "              ]),",
    "            ),",
    "          ),",
    "        }),",
    "      ]),",
    "    ),",
    "  );",
    "  return Object.freeze({ identity: sourceDescriptor.identity, nodes });",
    "}",
    "",
    'const runtimeAppRoot = fileURLToPath(new URL("../../../", import.meta.url));',
    "export const moduleMapDescriptor = createModuleMapDescriptor(runtimeAppRoot);",
    "export default moduleMapDescriptor;",
    "",
  ].join("\n");
}

export function createGenerationModuleMapBackingProjection(input: {
  readonly projectedManifest: CompiledAgentManifest;
  readonly runtimeAppRoot: string;
  readonly sourceManifest: CompiledAgentManifest;
}): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const sourceScopeList = collectCompiledModuleScopes(input.sourceManifest);
  const projectedScopeList = collectCompiledModuleScopes(input.projectedManifest);
  const sourceScopes = new Map(sourceScopeList.map((scope) => [scope.nodeId, scope]));
  const sourceNodeIds = sourceScopeList.map((scope) => scope.nodeId).sort();
  const projectedNodeIds = projectedScopeList.map((scope) => scope.nodeId).sort();
  if (JSON.stringify(sourceNodeIds) !== JSON.stringify(projectedNodeIds)) {
    throw new Error(
      "Cannot project a materialized module map because its selected node set changed.",
    );
  }

  return Object.fromEntries(
    projectedScopeList.map((projectedScope) => {
      const sourceScope = sourceScopes.get(projectedScope.nodeId);
      if (sourceScope === undefined) {
        throw new Error(
          `Cannot project materialized module-map node "${projectedScope.nodeId}" without its compiler source scope.`,
        );
      }
      const projectedSourceIds = [
        ...new Set(projectedScope.refs.map((ref) => ref.sourceId)),
      ].sort();
      const sourceSourceIds = [...new Set(sourceScope.refs.map((ref) => ref.sourceId))].sort();
      if (JSON.stringify(projectedSourceIds) !== JSON.stringify(sourceSourceIds)) {
        throw new Error(
          `Cannot project materialized module-map node "${projectedScope.nodeId}" because its selected source set changed.`,
        );
      }

      return [
        projectedScope.nodeId,
        Object.fromEntries(
          projectedSourceIds.map((sourceId) => {
            const projected = projectedScope.bindings[sourceId]?.backing;
            const source = sourceScope.bindings[sourceId]?.backing;
            if (projected === undefined || source === undefined) {
              throw new Error(
                `Cannot project materialized module-map binding "${projectedScope.nodeId}:${sourceId}" without both backings.`,
              );
            }
            assertRelocationOnly({ nodeId: projectedScope.nodeId, projected, source, sourceId });
            return [
              sourceId,
              createPortableBacking({
                projected,
                runtimeAppRoot: input.runtimeAppRoot,
                source,
              }),
            ];
          }),
        ),
      ];
    }),
  );
}

export function hydrateGenerationModuleMapBackingProjection(
  value: unknown,
  runtimeAppRoot: string,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof Reflect.get(value, RUNTIME_RELATIVE_PATH) === "string"
  ) {
    return resolveRuntimeProjectionPath(
      runtimeAppRoot,
      Reflect.get(value, RUNTIME_RELATIVE_PATH) as string,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => hydrateGenerationModuleMapBackingProjection(entry, runtimeAppRoot));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      hydrateGenerationModuleMapBackingProjection(entry, runtimeAppRoot),
    ]),
  );
}

function assertRelocationOnly(input: {
  readonly nodeId: string;
  readonly projected: CompiledModuleBacking;
  readonly source: CompiledModuleBacking;
  readonly sourceId: string;
}): void {
  const normalize = (backing: CompiledModuleBacking): unknown =>
    backing.kind === "programmatic"
      ? backing
      : {
          ...backing,
          ...(backing.extensionScope === undefined
            ? {}
            : { extensionScope: { ...backing.extensionScope, sourceRoot: "$path" } }),
          sourcePath: "$path",
        };
  if (JSON.stringify(normalize(input.source)) !== JSON.stringify(normalize(input.projected))) {
    throw new Error(
      `Cannot project materialized module-map binding "${input.nodeId}:${input.sourceId}" because non-path backing semantics changed.`,
    );
  }
}

function createPortableBacking(input: {
  readonly projected: CompiledModuleBacking;
  readonly runtimeAppRoot: string;
  readonly source: CompiledModuleBacking;
}): unknown {
  const projected = input.projected;
  const source = input.source;
  if (projected.kind === "programmatic") {
    return projected;
  }
  if (source.kind === "programmatic") {
    throw new Error("Cannot project a filesystem module backing from a programmatic source.");
  }
  return Object.fromEntries(
    Object.entries(projected).map(([key, value]) => {
      if (key === "sourcePath") {
        return [
          key,
          createPortablePath(source.sourcePath, projected.sourcePath, input.runtimeAppRoot),
        ];
      }
      if (key === "extensionScope" && projected.extensionScope !== undefined) {
        return [
          key,
          {
            ...projected.extensionScope,
            sourceRoot: createPortablePath(
              source.extensionScope?.sourceRoot,
              projected.extensionScope.sourceRoot,
              input.runtimeAppRoot,
            ),
          },
        ];
      }
      return [key, value];
    }),
  );
}

function createPortablePath(
  sourcePath: string | undefined,
  projectedPath: string,
  runtimeAppRoot: string,
): string | Readonly<Record<typeof RUNTIME_RELATIVE_PATH, string>> {
  if (sourcePath === projectedPath) return projectedPath;
  const relativePath = relative(runtimeAppRoot, projectedPath);
  if (isAbsolute(relativePath)) return projectedPath;
  return { [RUNTIME_RELATIVE_PATH]: (relativePath || ".").split(sep).join("/") };
}

function resolveRuntimeProjectionPath(runtimeAppRoot: string, relativePath: string): string {
  return resolve(runtimeAppRoot, relativePath.split("/").join(sep));
}
