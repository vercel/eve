import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledSandboxDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectObjectRecord, getAuthoredModuleExport } from "#internal/authored-module.js";
import { ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { getBoundSandboxEnvironment, isSandboxEnvironment } from "#shared/sandbox-environment.js";

export async function resolveSandboxDefinition(
  definition: CompiledSandboxDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedSandboxDefinition> {
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
    dockerfileHash: definition.dockerfileHash,
    exportName: definition.exportName,
    logicalPath: definition.logicalPath,
    selector: selector as ResolvedSandboxDefinition["selector"],
    sourceHash: definition.sourceHash,
    sourceId: definition.sourceId,
    sourceKind: "module" as const,
  };
  if (definition.inheritsParent === true) return { ...base, kind: "parent" };
  if (!isSandboxEnvironment(environment))
    throw new ResolveAgentError(`Sandbox "${definition.logicalPath}" has no environment.`);
  return { ...base, environment, kind: "independent" };
}
