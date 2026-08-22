import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "#compiled/zod/index.js";
import type {
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledExtensionMount,
} from "#compiler/manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-references.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export type AgentSourceOwner = z.infer<typeof agentSourceOwnerSchema>;
export type CompiledModuleBacking = z.infer<typeof compiledModuleBackingSchema>;
export type CompiledModuleBinding = z.infer<typeof compiledModuleBindingSchema>;

const agentSourceOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application") }).strict(),
  z.object({ feature: z.string(), kind: z.literal("framework") }).strict(),
  z
    .object({
      kind: z.literal("extension"),
      namespace: z.string(),
      packageName: z.string(),
    })
    .strict(),
]);

const compiledModuleBackingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      externalDependencies: z.array(z.string()).readonly(),
      extensionScope: z
        .object({ namespace: z.string(), sourceRoot: z.string() })
        .strict()
        .optional(),
      kind: z.literal("filesystem"),
      sourcePath: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("programmatic"),
      moduleId: z.string(),
      registryId: z.string(),
    })
    .strict(),
]);

export const compiledModuleBindingSchema = z
  .object({
    backing: compiledModuleBackingSchema,
    logicalPath: z.string(),
    owner: agentSourceOwnerSchema,
  })
  .strict();

export function createFilesystemModuleBindings(input: {
  readonly additionalRefs?: readonly ModuleSourceRef[];
  readonly agentRoot: string;
  readonly externalDependencies?: readonly string[];
  readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
}): Record<string, CompiledModuleBinding> {
  const bindings: Record<string, CompiledModuleBinding> = {};
  const extensionMounts = input.manifest.extensionMounts;

  for (const ref of [
    ...collectModuleRefsForManifest(input.manifest),
    ...(input.additionalRefs ?? []),
  ]) {
    const sourcePath = resolve(input.agentRoot, ref.logicalPath);
    const extension = extensionMounts.find((mount) => isPathInside(mount.sourceRoot, sourcePath));
    const existing = bindings[ref.sourceId];

    if (existing !== undefined) {
      if (existing.logicalPath !== ref.logicalPath) {
        throw new Error(
          `Module source id "${ref.sourceId}" refers to both "${existing.logicalPath}" and "${ref.logicalPath}".`,
        );
      }
      continue;
    }

    bindings[ref.sourceId] = createFilesystemModuleBinding({
      externalDependencies: input.externalDependencies,
      extension,
      logicalPath: ref.logicalPath,
      sourcePath,
    });
  }

  return bindings;
}

export function assertTotalModuleBindings(input: {
  readonly additionalRefs?: readonly ModuleSourceRef[];
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly manifest: CompiledAgentNodeManifest | CompiledAgentResources;
  readonly nodeId: string;
}): void {
  const refs = new Map(
    [...collectModuleRefsForManifest(input.manifest), ...(input.additionalRefs ?? [])].map(
      (ref) => [ref.sourceId, ref],
    ),
  );

  for (const [sourceId, ref] of refs) {
    const binding = input.bindings[sourceId];
    if (binding === undefined) {
      throw new Error(`Compiled node "${input.nodeId}" is missing a binding for "${sourceId}".`);
    }
    if (binding.logicalPath !== ref.logicalPath) {
      throw new Error(
        `Compiled node "${input.nodeId}" binds "${sourceId}" to "${binding.logicalPath}", but its manifest references "${ref.logicalPath}".`,
      );
    }
  }

  for (const sourceId of Object.keys(input.bindings)) {
    if (!refs.has(sourceId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" has an unreferenced binding for "${sourceId}".`,
      );
    }
  }
}

function createFilesystemModuleBinding(input: {
  readonly externalDependencies?: readonly string[];
  readonly extension?: CompiledExtensionMount;
  readonly logicalPath: string;
  readonly sourcePath: string;
}): CompiledModuleBinding {
  const extension = input.extension;
  return {
    backing: {
      externalDependencies: [...(input.externalDependencies ?? [])],
      extensionScope:
        extension === undefined
          ? undefined
          : { namespace: extension.packageNamespace, sourceRoot: extension.sourceRoot },
      kind: "filesystem",
      sourcePath: input.sourcePath,
    },
    logicalPath: input.logicalPath,
    owner:
      extension === undefined
        ? { kind: "application" }
        : {
            kind: "extension",
            namespace: extension.namespace,
            packageName: extension.packageName,
          },
  };
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
