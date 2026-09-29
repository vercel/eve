import { posix } from "node:path";

import { bindingMountId } from "#compiler/extension-mount-bindings.js";
import { NodeModuleEvaluationContext } from "#compiler/module-lifecycle.js";
import type { NodeCompileInput } from "#compiler/normalize-manifest-types.js";
import type { AgentSourceRegistry } from "#compiler/source-graph.js";
import { mountRefNamespace } from "#discover/extensions.js";
import type { AuthoredModuleLoadOptions } from "#internal/authored-module-loader.js";

export type ExtensionCompileMount = NonNullable<AuthoredModuleLoadOptions["mount"]>;

export function createMountEvaluationContext(input: {
  readonly node: NodeCompileInput;
  readonly registries: readonly AgentSourceRegistry[];
  readonly mounts: Map<string, ExtensionCompileMount>;
  readonly evaluationId: string;
}): NodeModuleEvaluationContext {
  const sourceIds = new Map<string, string>();
  for (const mount of input.node.manifest.resolvedExtensions) {
    const mountId = posix.join(input.node.nodePath, "extensions", mount.namespace);
    const declaration =
      mount.programmaticDeclaration ??
      input.node.manifest.extensions.find(
        (ref) => mountRefNamespace(ref.logicalPath) === mount.namespace,
      );
    if (declaration === undefined) continue;
    sourceIds.set(mountId, declaration.sourceId);
    input.mounts.set(mountId, {
      mountId,
      mountSourcePath: posix.join(input.node.manifest.agentRoot, declaration.logicalPath),
      packageName: mount.packageName,
        sourceRoot: mount.sourceRoot,
      specifier: mount.specifier,
      ...(mount.programmaticDeclaration === undefined
        ? {}
        : {
            programmaticImport: {
              specifier: mount.programmaticDeclaration.importSpecifier,
              entryPath: mount.programmaticDeclaration.entryPath,
              config: mount.programmaticDeclaration.config,
            },
          }),
    });
  }
  return new NodeModuleEvaluationContext(
    input.registries,
    (binding) => sourceIds.get(bindingMountId(binding) ?? ""),
    input.mounts,
    input.evaluationId,
  );
}
