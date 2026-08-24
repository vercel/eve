import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { z } from "#compiled/zod/index.js";
import type { CompiledAgentManifest, CompiledAgentResources } from "#compiler/manifest.js";
import { collectCompiledModuleScopes, type CompiledModuleScope } from "#compiler/module-scope.js";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { createFilesystemModuleSemanticHash } from "#compiler/module-backing-identity.js";
import {
  FRAMEWORK_AGENT_SOURCE_ID,
  FRAMEWORK_ROOT_AGENT_SOURCE_ID,
} from "#framework-sources/constants.js";
import { freezeCompiledModuleMap } from "#protocol/compiled-module-map-identity.js";

/** Compiled module ownership for one runtime graph node. */
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
 * Input for generating the compiled authored module map artifact.
 */
export interface CreateCompiledModuleMapDescriptorSourceInput {
  /**
   * Controls how generated authored-module loader imports are written.
   * Relative specifiers are the compiler default; absolute specifiers are
   * useful when a bundler consumes the module map from a virtual module id.
   */
  importSpecifierStyle?: "absolute" | "relative";
  /** Content identity calculated before the executable map source is emitted. */
  identity: string;
  manifest: CompiledAgentManifest;
  moduleMapPath: string;
  programmaticRegistryImports?: Readonly<
    Record<string, { readonly exportName: string; readonly importSpecifier: string }>
  >;
}

interface CollectedModuleImport {
  readonly backing: CompiledAgentResources["bindings"][string]["backing"];
  readonly loaderExpression: string;
  readonly sourceId: string;
  readonly validatorExpression?: string;
}

interface CollectedModuleNodeScope {
  readonly modules: readonly CollectedModuleImport[];
  readonly nodeId: string;
}

/**
 * Generates a literal descriptor whose loaders do not evaluate authored or
 * programmatic namespaces until the bundled artifact envelope is validated.
 */
export function createCompiledModuleMapDescriptorSource(
  input: CreateCompiledModuleMapDescriptorSourceInput,
): string {
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
  const scopes = collectCompiledModuleScopes(input.manifest).map((scope) =>
    collectModuleNodeScope({
      importSpecifierStyle,
      moduleMapDirectory,
      programmaticRegistryImports,
      scope,
    }),
  );

  return renderFrozenObject(
    [
      { key: "identity", value: JSON.stringify(input.identity) },
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
                      value: renderFrozenObject(
                        [
                          { key: "artifactIdentity", value: JSON.stringify(input.identity) },
                          { key: "backing", value: JSON.stringify(moduleImport.backing) },
                          { key: "load", value: moduleImport.loaderExpression },
                          ...(moduleImport.validatorExpression === undefined
                            ? []
                            : [{ key: "validate", value: moduleImport.validatorExpression }]),
                        ],
                        5,
                      ),
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

/** Generates a lazy module-map descriptor as a standalone ESM artifact. */
export function createCompiledModuleMapDescriptorModuleSource(
  input: CreateCompiledModuleMapDescriptorSourceInput,
): string {
  const descriptor = createCompiledModuleMapDescriptorSource(input);
  return [
    "// Generated by eve. Do not edit by hand.",
    "",
    `export const moduleMapDescriptor = ${descriptor};`,
    "",
    "export default moduleMapDescriptor;",
    "",
  ].join("\n");
}

/** Hashes the selected module sources and programmatic registrations. */
export async function createCompiledModuleMapIdentity(
  manifest: CompiledAgentManifest,
): Promise<string> {
  const records: Array<Record<string, unknown>> = [];

  for (const scope of collectCompiledModuleScopes(manifest)) {
    for (const ref of [...scope.refs].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId),
    )) {
      const binding = scope.bindings[ref.sourceId];
      if (binding === undefined) {
        throw new Error(
          `Cannot identify compiled module "${ref.sourceId}" on node "${scope.nodeId}" without a binding.`,
        );
      }
      const backing = binding.backing;
      records.push({
        backing:
          backing.kind === "filesystem"
            ? {
                externalDependencies: backing.externalDependencies,
                extensionScope:
                  backing.extensionScope === undefined
                    ? undefined
                    : { namespace: backing.extensionScope.namespace },
                kind: backing.kind,
                sha256: await createFilesystemModuleSemanticHash(
                  backing,
                  manifest.externalDependencyPlan,
                ),
              }
            : {
                kind: backing.kind,
                moduleId: backing.moduleId,
                registryId: backing.registryId,
                revision: backing.revision,
                semanticRevision: backing.semanticRevision,
              },
        logicalPath: binding.logicalPath,
        nodeId: scope.nodeId,
        owner: binding.owner,
        sourceId: ref.sourceId,
      });
    }
  }

  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/** Creates the same identity without I/O when every selected source is programmatic. */
export function createProgrammaticCompiledModuleMapIdentity(
  manifest: CompiledAgentManifest,
): string {
  const records: Array<Record<string, unknown>> = [];
  for (const scope of collectCompiledModuleScopes(manifest)) {
    for (const ref of [...scope.refs].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId),
    )) {
      const binding = scope.bindings[ref.sourceId];
      if (binding === undefined) {
        throw new Error(
          `Cannot identify compiled module "${ref.sourceId}" on node "${scope.nodeId}" without a binding.`,
        );
      }
      if (binding.backing.kind !== "programmatic") {
        throw new Error(
          `Cannot synchronously identify filesystem-backed compiled module "${ref.sourceId}".`,
        );
      }
      records.push({
        backing: {
          kind: binding.backing.kind,
          moduleId: binding.backing.moduleId,
          registryId: binding.backing.registryId,
          revision: binding.backing.revision,
          semanticRevision: binding.backing.semanticRevision,
        },
        logicalPath: binding.logicalPath,
        nodeId: scope.nodeId,
        owner: binding.owner,
        sourceId: ref.sourceId,
      });
    }
  }
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/** Hydrates a module map from only the selected programmatic runtime bindings. */
export async function createProgrammaticCompiledModuleMap(input: {
  readonly manifest: CompiledAgentManifest;
  readonly registry: AgentSourceRegistry;
}): Promise<CompiledModuleMap> {
  const nodes: Record<string, { modules: Record<string, Record<string, unknown>> }> = {};
  const scopes = collectCompiledModuleScopes(input.manifest);

  const selectedBackings = scopes.flatMap((scope) =>
    scope.refs.flatMap((ref) => {
      const backing = scope.bindings[ref.sourceId]?.backing;
      return backing?.kind === "programmatic" ? [backing] : [];
    }),
  );
  input.registry.validateModules(selectedBackings);

  for (const scope of scopes) {
    const modules: Record<string, Record<string, unknown>> = {};
    for (const ref of scope.refs) {
      const binding = scope.bindings[ref.sourceId]!;
      if (binding.backing.kind !== "programmatic") continue;
      modules[ref.sourceId] = { ...(await input.registry.loadModule(binding.backing)) };
    }
    nodes[scope.nodeId] = Object.freeze({ modules: Object.freeze(modules) });
  }

  return freezeCompiledModuleMap(compiledModuleMapSchema.parse({ nodes: Object.freeze(nodes) }));
}

function collectModuleNodeScope(input: {
  readonly importSpecifierStyle: "absolute" | "relative";
  readonly moduleMapDirectory: string;
  readonly programmaticRegistryImports?: CreateCompiledModuleMapDescriptorSourceInput["programmaticRegistryImports"];
  readonly scope: CompiledModuleScope;
}): CollectedModuleNodeScope {
  return {
    modules: [...input.scope.refs]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((moduleSourceRef) =>
        collectModuleImport({
          binding: input.scope.bindings[moduleSourceRef.sourceId]!,
          importSpecifierStyle: input.importSpecifierStyle,
          moduleMapDirectory: input.moduleMapDirectory,
          nodeId: input.scope.nodeId,
          programmaticRegistryImports: input.programmaticRegistryImports,
          sourceId: moduleSourceRef.sourceId,
        }),
      ),
    nodeId: input.scope.nodeId,
  };
}

export {
  collectModuleRefsForManifest,
  collectUniqueModuleRefsForManifest,
} from "#compiler/module-references.js";

function collectModuleImport(input: {
  readonly binding: CompiledAgentResources["bindings"][string];
  readonly importSpecifierStyle: "absolute" | "relative";
  readonly moduleMapDirectory: string;
  readonly nodeId: string;
  readonly programmaticRegistryImports?: CreateCompiledModuleMapDescriptorSourceInput["programmaticRegistryImports"];
  readonly sourceId: string;
}): CollectedModuleImport {
  if (input.binding.backing.kind === "filesystem") {
    const importSpecifier = createImportSpecifier({
      fromDirectory: input.moduleMapDirectory,
      importSpecifierStyle: input.importSpecifierStyle,
      targetPath: input.binding.backing.sourcePath,
    });
    return {
      backing: input.binding.backing,
      loaderExpression: `() => import(${JSON.stringify(importSpecifier)})`,
      sourceId: input.sourceId,
    };
  }

  const registryImport = input.programmaticRegistryImports?.[input.binding.backing.registryId];
  if (registryImport === undefined) {
    throw new Error(
      `Cannot generate programmatic binding "${input.sourceId}" on compiled node "${input.nodeId}" because registry "${input.binding.backing.registryId}" has no compiler-owned import.`,
    );
  }
  return {
    backing: input.binding.backing,
    loaderExpression: `async () => (await import(${JSON.stringify(registryImport.importSpecifier)})).${registryImport.exportName}.loadModule(${JSON.stringify(input.binding.backing)})`,
    sourceId: input.sourceId,
    validatorExpression: `async () => (await import(${JSON.stringify(registryImport.importSpecifier)})).${registryImport.exportName}.validateModules([${JSON.stringify(input.binding.backing)}])`,
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
