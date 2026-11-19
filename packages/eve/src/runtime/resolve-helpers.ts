import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  expectObjectRecord,
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import type { ResolvedModuleSourceRef } from "#runtime/types.js";

export class ResolveAgentError extends Error {
  readonly logicalPath?: string;
  readonly sourceId?: string;

  constructor(
    message: string,
    input: {
      logicalPath?: string;
      sourceId?: string;
    } = {},
  ) {
    super(message);
    this.name = "ResolveAgentError";

    if (input.logicalPath !== undefined) {
      this.logicalPath = input.logicalPath;
    }

    if (input.sourceId !== undefined) {
      this.sourceId = input.sourceId;
    }
  }
}

export function createResolvedModuleSourceRef(sourceRef: {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
}): ResolvedModuleSourceRef {
  return {
    exportName: sourceRef.exportName,
    logicalPath: sourceRef.logicalPath,
    sourceId: sourceRef.sourceId,
    sourceKind: "module",
  };
}

export async function loadResolvedModuleExport(input: {
  readonly definition: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId: string;
  };
  readonly kindLabel: string;
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string | undefined;
}): Promise<unknown> {
  const resolvedNodeId = input.nodeId ?? ROOT_COMPILED_AGENT_NODE_ID;
  const moduleNamespace = input.moduleMap.nodes[resolvedNodeId]?.modules[input.definition.sourceId];

  if (moduleNamespace === undefined) {
    throw new ResolveAgentError(
      `Missing compiled module namespace for ${input.kindLabel} source "${input.definition.sourceId}" in node "${resolvedNodeId}".`,
      {
        logicalPath: input.definition.logicalPath,
        sourceId: input.definition.sourceId,
      },
    );
  }

  const moduleRecord = expectObjectRecord(
    moduleNamespace,
    `Missing compiled module namespace for ${input.kindLabel} source "${input.definition.sourceId}" in node "${resolvedNodeId}".`,
  );
  const exportValue = getAuthoredModuleExport(moduleRecord, {
    exportName: input.definition.exportName,
    logicalPath: input.definition.logicalPath,
  });

  return await materializeAuthoredModuleExport(exportValue);
}
