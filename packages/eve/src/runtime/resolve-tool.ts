import type { CompiledToolDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { normalizeApproval } from "#internal/authored-definition/approval.js";
import {
  registerDefinitionSource,
  stampDefinitionKey,
} from "#internal/authored-definition/source-identity.js";
import { isToolSchema, toInputSchema, toOutputSchema } from "#tools/schema.js";
import { toErrorMessage } from "#shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";

/**
 * Resolves one compiled authored tool into a runtime-owned definition
 * with live callbacks reattached from the authored module.
 *
 * Schema-bearing module exports are retained when they implement the validated
 * runtime contract; serialized schemas from the compiled manifest are
 * otherwise rehydrated into live validators. Optional hooks are reattached
 * from the live module export.
 */
export async function resolveToolDefinition(
  definition: CompiledToolDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
  owner: AgentSourceOwner,
): Promise<ResolvedToolDefinition> {
  if (!definition.hasExecute) {
    return {
      behavior: definition.behavior,
      description: definition.description,
      inputSchema: toInputSchema(definition.inputSchema),
      logicalPath: definition.logicalPath,
      name: definition.name,
      outputSchema: toOutputSchema(definition.outputSchema),
      owner,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  }
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "tool",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(
      resolvedExportValue,
      describe(definition, "to return an object"),
    );

    const sourceEntry = {
      kind: "tool",
      logicalPath: definition.logicalPath,
      name: definition.name,
      owner,
    } as const;

    const sourceKey = `tool-source:${definition.sourceId}`;
    stampDefinitionKey(resolvedRecord, sourceKey);
    registerDefinitionSource(sourceKey, sourceEntry);
    registerDefinitionSource(`tool:${resolvedRecord.description}`, sourceEntry);

    const execute = expectFunction(
      resolvedRecord.execute,
      describe(definition, "to provide an execute function"),
    ) as NonNullable<ResolvedToolDefinition["execute"]>;
    const inputSchema = isToolSchema(resolvedRecord.inputSchema)
      ? resolvedRecord.inputSchema
      : toInputSchema(definition.inputSchema);
    const outputSchema = isToolSchema(resolvedRecord.outputSchema)
      ? resolvedRecord.outputSchema
      : toOutputSchema(definition.outputSchema);

    return {
      behavior: definition.behavior,
      description: definition.description,
      execute,
      execution: definition.execution,
      exportName: definition.exportName,
      inputSchema,
      logicalPath: definition.logicalPath,
      name: definition.name,
      owner,
      outputSchema,
      sourceId: definition.sourceId,
      sourceKind: "module",
      ...extractOptionalHooks(resolvedRecord, definition),
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to attach the tool execute function from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

/**
 * Mutable slice of {@link ResolvedToolDefinition} covering every
 * optional authored hook. Keys are only assigned when the authored
 * export declared the corresponding hook so callers can `...spread` the
 * result without clobbering required fields with `undefined`.
 */
type OptionalResolvedFields = {
  -readonly [K in "label" | "approval" | "toModelOutput"]?: ResolvedToolDefinition[K];
};

/**
 * Validates and extracts every optional hook declared on the authored
 * tool module, returning them as an {@link OptionalResolvedFields}
 * builder.
 */
function extractOptionalHooks(
  record: Record<string, unknown>,
  definition: CompiledToolDefinition,
): OptionalResolvedFields {
  const optional: OptionalResolvedFields = {};

  if (record.label !== undefined) {
    const label = expectObjectRecord(
      record.label,
      describe(definition, "to provide a valid label definition"),
    );
    optional.label = {
      complete:
        label.complete === undefined
          ? undefined
          : (expectFunction(
              label.complete,
              describe(definition, "to provide an label complete function"),
            ) as NonNullable<ResolvedToolDefinition["label"]>["complete"]),
      delta:
        label.delta === undefined
          ? undefined
          : (expectFunction(
              label.delta,
              describe(definition, "to provide an label delta function"),
            ) as NonNullable<ResolvedToolDefinition["label"]>["delta"]),
      start: expectFunction(
        label.start,
        describe(definition, "to provide a label start callback function"),
      ) as NonNullable<ResolvedToolDefinition["label"]>["start"],
    };
  }

  if (record.approval !== undefined) {
    optional.approval = normalizeApproval(
      record.approval,
      describe(definition, "to provide a valid approval definition"),
    );
  }

  if (record.toModelOutput !== undefined) {
    optional.toModelOutput = expectFunction(
      record.toModelOutput,
      describe(definition, "to provide a toModelOutput function"),
    ) as ResolvedToolDefinition["toModelOutput"];
  }

  return optional;
}

/**
 * Formats the "Expected the tool export ... {predicate}" message used
 * by every validation error in this file.
 */
function describe(definition: CompiledToolDefinition, predicate: string): string {
  return `Expected the tool export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
