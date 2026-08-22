import { fileURLToPath } from "node:url";

import { z } from "#compiled/zod/index.js";
import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { assertTotalModuleBindings, type CompiledModuleBinding } from "#compiler/module-binding.js";
import { collectModuleRefsForManifest } from "#compiler/module-references.js";
import {
  getProgrammaticModuleNamespace,
  type AgentSourceRegistry,
} from "#compiler/agent-source-registry.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  FRAMEWORK_AGENT_SOURCE_ID,
  FRAMEWORK_ROOT_AGENT_SOURCE_ID,
} from "#framework-sources/constants.js";

/**
 * Compiled module ownership for one runtime graph node.
 */
export type CompiledModuleNodeScope = z.infer<typeof compiledModuleNodeScopeSchema>;

/**
 * Flattened compiled authored module map keyed by stable node ids.
 */
export type CompiledModuleMap = z.infer<typeof compiledModuleMapSchema>;

const compiledModuleNodeScopeSchema = z
  .object({
    modules: z.record(z.string(), z.object({}).passthrough()),
  })
  .strict();

/**
 * Zod schema for the flattened compiled authored module map.
 */
export const compiledModuleMapSchema = z
  .object({
    nodes: z.record(z.string(), compiledModuleNodeScopeSchema),
  })
  .strict();

/**
 * Materializes a module map when every compiled binding is backed by one
 * programmatic source registry. This is the in-process counterpart to the
 * generated module-map artifact: both consume the compiled manifest's total
 * binding table instead of reconstructing modules from authored inputs.
 */
export function createProgrammaticCompiledModuleMap(input: {
  readonly manifest: CompiledAgentManifest;
  readonly registry: AgentSourceRegistry;
}): CompiledModuleMap {
  return {
    nodes: Object.fromEntries(
      collectBoundModuleNodeScopes(input.manifest).map((node) => [
        node.nodeId,
        {
          modules: Object.fromEntries(
            node.modules.map(({ binding, sourceId }) => {
              if (binding.backing.kind !== "programmatic") {
                throw new Error(
                  `Cannot materialize filesystem binding "${sourceId}" on compiled node "${node.nodeId}" without generating a module-map artifact.`,
                );
              }
              return [sourceId, getProgrammaticModuleNamespace(input.registry, binding.backing)];
            }),
          ),
        },
      ]),
    ),
  };
}

/**
 * Input for generating the compiled authored module map artifact.
 */
export interface CreateCompiledModuleMapSourceInput {
  /**
   * Controls how generated authored-module imports are written. Relative
   * specifiers are the compiler default; absolute specifiers are useful when a
   * bundler consumes the module map from a virtual module id.
   */
  importSpecifierStyle?: "absolute" | "relative";
  manifest: CompiledAgentManifest;
  moduleMapPath: string;
  programmaticRegistryImports?: Readonly<
    Record<string, { readonly exportName: string; readonly importSpecifier: string }>
  >;
}

interface CollectedModuleImport {
  readonly bindingName: string;
  readonly importStatement: string;
  readonly moduleExpression: string;
  readonly sourceId: string;
}

interface CollectedModuleNodeScope {
  readonly modules: readonly CollectedModuleImport[];
  readonly nodeId: string;
}

interface CollectedBoundModuleNodeScope {
  readonly modules: ReadonlyArray<{
    readonly binding: CompiledModuleBinding;
    readonly sourceId: string;
  }>;
  readonly nodeId: string;
}

function collectBoundModuleNodeScopes(
  manifest: CompiledAgentManifest,
): CollectedBoundModuleNodeScope[] {
  return [
    collectBoundModuleNodeScope({
      manifest,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    }),
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) =>
        collectBoundModuleNodeScope({
          additionalModuleRef: subagent.configResolver,
          manifest: subagent.agent,
          nodeId: subagent.nodeId,
        }),
      ),
  ];
}

function collectBoundModuleNodeScope(input: {
  readonly additionalModuleRef?: ModuleSourceRef;
  readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
  readonly nodeId: string;
}): CollectedBoundModuleNodeScope {
  assertTotalModuleBindings({
    additionalRefs: input.additionalModuleRef === undefined ? [] : [input.additionalModuleRef],
    bindings: input.manifest.bindings,
    manifest: input.manifest,
    nodeId: input.nodeId,
  });

  return {
    modules: [
      ...collectModuleRefsForManifest(input.manifest),
      ...(input.additionalModuleRef === undefined ? [] : [input.additionalModuleRef]),
    ]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((source) => ({
        binding: input.manifest.bindings[source.sourceId]!,
        sourceId: source.sourceId,
      })),
    nodeId: input.nodeId,
  };
}

/**
 * Generates the compiler-owned module map artifact that statically imports
 * every module-backed authored source.
 */
export function createCompiledModuleMapSource(input: CreateCompiledModuleMapSourceInput): string {
  const moduleMapDirectory = dirnameFilesystemPath(input.moduleMapPath);
  const importSpecifierStyle = input.importSpecifierStyle ?? "relative";
  const programmaticRegistryImports = {
    [FRAMEWORK_AGENT_SOURCE_ID]: {
      exportName: "frameworkAgentSourceRegistry",
      importSpecifier: normalizeEsmImportSpecifier(
        fileURLToPath(new URL("../framework-sources/registry.js", import.meta.url)),
      ),
    },
    [FRAMEWORK_ROOT_AGENT_SOURCE_ID]: {
      exportName: "frameworkAgentSourceRegistry",
      importSpecifier: normalizeEsmImportSpecifier(
        fileURLToPath(new URL("../framework-sources/registry.js", import.meta.url)),
      ),
    },
    ...input.programmaticRegistryImports,
  };
  let nextBindingIndex = 0;
  const collectedScopes: CollectedModuleNodeScope[] = collectBoundModuleNodeScopes(
    input.manifest,
  ).map((scope) => ({
    modules: scope.modules.map(({ binding, sourceId }) =>
      collectModuleImport({
        binding,
        bindingName: `module_${nextBindingIndex++}`,
        importSpecifierStyle,
        moduleMapDirectory,
        nodeId: scope.nodeId,
        programmaticRegistryImports,
        sourceId,
      }),
    ),
    nodeId: scope.nodeId,
  }));
  const allModules = collectedScopes.flatMap((scope) => scope.modules);

  const staticImports = allModules.map((moduleImport) => moduleImport.importStatement);

  return [
    "// Generated by eve. Do not edit by hand.",
    "",
    ...staticImports,
    ...(staticImports.length > 0 ? [""] : []),
    `export const moduleMap = ${renderModuleMap(collectedScopes)};`,
    "",
    "export default moduleMap;",
    "",
  ].join("\n");
}

export { collectModuleRefsForManifest } from "#compiler/module-references.js";

function collectModuleImport(input: {
  readonly binding: CompiledAgentResources["bindings"][string];
  readonly bindingName: string;
  readonly importSpecifierStyle: "absolute" | "relative";
  readonly moduleMapDirectory: string;
  readonly nodeId: string;
  readonly programmaticRegistryImports?: CreateCompiledModuleMapSourceInput["programmaticRegistryImports"];
  readonly sourceId: string;
}): CollectedModuleImport {
  if (input.binding.backing.kind === "filesystem") {
    const importSpecifier = createImportSpecifier({
      fromDirectory: input.moduleMapDirectory,
      importSpecifierStyle: input.importSpecifierStyle,
      targetPath: input.binding.backing.sourcePath,
    });
    return {
      bindingName: input.bindingName,
      importStatement: `import * as ${input.bindingName} from ${JSON.stringify(importSpecifier)};`,
      moduleExpression: input.bindingName,
      sourceId: input.sourceId,
    };
  }

  const registryImport = input.programmaticRegistryImports?.[input.binding.backing.registryId];
  if (registryImport === undefined) {
    throw new Error(
      `Cannot generate programmatic binding "${input.sourceId}" on compiled node "${input.nodeId}" because registry "${input.binding.backing.registryId}" has no static import.`,
    );
  }
  return {
    bindingName: input.bindingName,
    importStatement: `import { ${registryImport.exportName} as ${input.bindingName} } from ${JSON.stringify(registryImport.importSpecifier)};`,
    moduleExpression: `${input.bindingName}.getModule(${JSON.stringify(input.binding.backing)}).namespace`,
    sourceId: input.sourceId,
  };
}

function createImportSpecifier(input: {
  fromDirectory: string;
  importSpecifierStyle: "absolute" | "relative";
  targetPath: string;
}): string {
  if (input.importSpecifierStyle === "absolute") {
    return normalizeEsmImportSpecifier(normalizeFilesystemPath(input.targetPath));
  }

  const relativeSpecifier = relativeFilesystemPath(input.fromDirectory, input.targetPath);

  if (relativeSpecifier.startsWith(".")) {
    return relativeSpecifier;
  }

  return `./${relativeSpecifier}`;
}

function renderModuleMap(scopes: readonly CollectedModuleNodeScope[]): string {
  return renderFrozenObject(
    [
      {
        key: "nodes",
        value: renderFrozenObject(
          scopes.map((scope) => ({
            key: scope.nodeId,
            value: renderFrozenObject(
              [
                {
                  key: "modules",
                  value: renderFrozenObject(
                    scope.modules.map((moduleImport) => ({
                      key: moduleImport.sourceId,
                      value: moduleImport.moduleExpression,
                    })),
                  ),
                },
              ],
              3,
            ),
          })),
        ),
      },
    ],
    0,
  );
}

function renderFrozenObject(
  entries: ReadonlyArray<{
    key: string;
    value: string;
  }>,
  depth: number = 1,
): string {
  if (entries.length === 0) {
    return "Object.freeze({})";
  }

  const indentation = "  ".repeat(depth);
  const nestedIndentation = "  ".repeat(depth + 1);

  return [
    "Object.freeze({",
    entries
      .map((entry) => {
        return `${nestedIndentation}${JSON.stringify(entry.key)}: ${entry.value.replaceAll("\n", `\n${nestedIndentation}`)}`;
      })
      .join(",\n"),
    `${indentation}})`,
  ].join("\n");
}

function dirnameFilesystemPath(path: string): string {
  const parsed = splitFilesystemPath(path);

  if (parsed.segments.length === 0) {
    return parsed.root.length === 0 ? "." : parsed.root;
  }

  return createFilesystemPath(parsed.root, parsed.segments.slice(0, -1));
}

function relativeFilesystemPath(fromDirectory: string, targetPath: string): string {
  const from = splitFilesystemPath(fromDirectory);
  const target = splitFilesystemPath(targetPath);

  if (from.root !== target.root) {
    return normalizeFilesystemPath(targetPath);
  }

  let sharedIndex = 0;

  while (
    sharedIndex < from.segments.length &&
    sharedIndex < target.segments.length &&
    from.segments[sharedIndex] === target.segments[sharedIndex]
  ) {
    sharedIndex += 1;
  }

  const relativeSegments = [
    ...Array.from({ length: from.segments.length - sharedIndex }, () => ".."),
    ...target.segments.slice(sharedIndex),
  ];

  return relativeSegments.length === 0 ? "." : relativeSegments.join("/");
}

function normalizeFilesystemPath(path: string): string {
  const parsed = splitFilesystemPath(path);
  return createFilesystemPath(parsed.root, parsed.segments);
}

function splitFilesystemPath(path: string): {
  readonly root: string;
  readonly segments: string[];
} {
  const normalized = path.replaceAll("\\", "/");
  let root = "";
  let remainder = normalized;

  const windowsDriveMatch = normalized.match(/^[A-Za-z]:/);

  if (windowsDriveMatch !== null) {
    root = windowsDriveMatch[0];
    remainder = normalized.slice(root.length);

    if (remainder.startsWith("/")) {
      root = `${root}/`;
      remainder = remainder.slice(1);
    }
  } else if (normalized.startsWith("/")) {
    root = "/";
    remainder = normalized.slice(1);
  }

  const segments: string[] = [];

  for (const segment of remainder.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
        continue;
      }

      if (root.length === 0) {
        segments.push(segment);
      }

      continue;
    }

    segments.push(segment);
  }

  return {
    root,
    segments,
  };
}

function createFilesystemPath(root: string, segments: readonly string[]): string {
  if (root === "/") {
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }

  if (root.endsWith("/")) {
    return segments.length === 0 ? root : `${root}${segments.join("/")}`;
  }

  if (root.length > 0) {
    return segments.length === 0 ? root : `${root}/${segments.join("/")}`;
  }

  return segments.length === 0 ? "." : segments.join("/");
}
