import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectObjectRecord, getAuthoredModuleExport } from "#internal/authored-module.js";
import { isSandboxDefinition, type SandboxDefinition } from "#public/definitions/sandbox.js";
import { isSandboxTemplate } from "#shared/sandbox-template.js";
import { ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

/**
 * Attaches the runtime definition and statically discovered template exports
 * from one compiled sandbox module.
 */
export function resolveSandboxDefinition(
  definition: CompiledSandboxDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
  templateReferences: Readonly<Record<string, unknown>>,
): ResolvedSandboxDefinition {
  const resolvedNodeId = nodeId ?? ROOT_COMPILED_AGENT_NODE_ID;
  const moduleNamespace = moduleMap.nodes[resolvedNodeId]?.modules[definition.sourceId];
  const moduleRecord = expectObjectRecord(
    moduleNamespace,
    `Missing compiled module namespace for sandbox source "${definition.sourceId}" in node "${resolvedNodeId}".`,
  );
  const authoredDefinition = getAuthoredModuleExport(moduleRecord, definition);

  if (!isSandboxDefinition(authoredDefinition)) {
    throw new ResolveAgentError(
      `Sandbox "${definition.logicalPath}" must export defineSandbox((ctx) => sandbox).`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }

  const templates = definition.templateExports.map((exportName) => {
    const template = moduleRecord[exportName];
    if (!isSandboxTemplate(template)) {
      throw new ResolveAgentError(
        `Sandbox template export "${exportName}" from "${definition.logicalPath}" is unavailable at runtime.`,
        {
          logicalPath: definition.logicalPath,
          sourceId: definition.sourceId,
        },
      );
    }
    return {
      exportName,
      reference: templateReferences[exportName],
      template,
    };
  });

  return {
    definition: authoredDefinition as SandboxDefinition,
    exportName: definition.exportName,
    logicalPath: definition.logicalPath,
    sourceHash: definition.sourceHash,
    sourceId: definition.sourceId,
    sourceKind: "module",
    templates,
  };
}
