import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledSandboxDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectObjectRecord, getAuthoredModuleExport } from "#internal/authored-module.js";
import { defineParentSandbox } from "#public/definitions/sandbox.js";
import { ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { getBoundSandboxEnvironment, isSandboxEnvironment } from "#shared/sandbox-environment.js";

export async function resolveSandboxDefinition(
  definition: CompiledSandboxDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedSandboxDefinition> {
  if (definition.inheritsParent === true) {
    return {
      exportName: definition.exportName,
      kind: "parent",
      logicalPath: definition.logicalPath,
      revisionHash: definition.revisionHash,
      selector: defineParentSandbox(),
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  }

  const namespace =
    moduleMap.nodes[nodeId ?? ROOT_COMPILED_AGENT_NODE_ID]?.modules[definition.sourceId];
  const record = expectObjectRecord(
    namespace,
    `Missing sandbox module "${definition.logicalPath}".`,
  );
  const selector = getAuthoredModuleExport(record, definition);
  if (typeof selector !== "function")
    throw new ResolveAgentError(`Sandbox "${definition.logicalPath}" does not export a selector.`);
  const environment = definition.environmentExportName
    ? record[definition.environmentExportName]
    : getBoundSandboxEnvironment(selector);
  const base = {
    exportName: definition.exportName,
    logicalPath: definition.logicalPath,
    revisionHash: definition.revisionHash,
    selector: selector as ResolvedSandboxDefinition["selector"],
    sourceId: definition.sourceId,
    sourceKind: "module" as const,
  };
  if (!isSandboxEnvironment(environment))
    throw new ResolveAgentError(`Sandbox "${definition.logicalPath}" has no environment.`);
  return { ...base, environment, kind: "independent" };
}
