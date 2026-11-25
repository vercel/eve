import type { CompiledToolDefinition } from "#compiler/manifest.js";
import {
  isFrameworkTool,
  frameworkTool,
  isInteractionOnly,
  markInteractionOnly,
} from "#tools/provided/framework-tool.js";
import type { CompiledModuleMap } from "#compiler/module-map-schema.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { normalizeApproval } from "#internal/authored-definition/approval.js";
import { registerDefinitionSource } from "#internal/authored-definition/source-identity.js";
import { isToolSchema, toInputSchema, toOutputSchema } from "#tools/schema.js";
import { toErrorMessage } from "#shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import { createWorkflowProgramExecuteInput } from "#tools/workflow-program-input.js";

export async function resolveToolDefinition(
  definition: CompiledToolDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
  owner: AgentSourceOwner,
): Promise<ResolvedToolDefinition> {
  if (!definition.hasExecute) {
    const resolved: ResolvedToolDefinition = {
      availableInSubagents: definition.availableInSubagents,
      behavior: definition.behavior,
      deferred: definition.deferred,
      description: definition.description,
      inputSchema: toInputSchema(definition.inputSchema),
      logicalPath: definition.logicalPath,
      name: definition.name,
      outputSchema: toOutputSchema(definition.outputSchema),
      owner,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
    return definition.behavior?.handling?.kind === "provider-tool"
      ? frameworkTool(resolved)
      : resolved;
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

    registerDefinitionSource(
      resolvedRecord,
      { kind: "tool", logicalPath: definition.logicalPath, name: definition.name },
      `tool:${resolvedRecord.description}`,
    );

    const execute =
      definition.behavior?.handling?.kind === "workflow-tool"
        ? undefined
        : (expectFunction(
            resolvedRecord.execute,
            describe(definition, "to provide an execute function"),
          ) as NonNullable<ResolvedToolDefinition["execute"]>);
    const inputSchema = isToolSchema(resolvedRecord.inputSchema)
      ? resolvedRecord.inputSchema
      : toInputSchema(definition.inputSchema);
    const outputSchema = isToolSchema(resolvedRecord.outputSchema)
      ? resolvedRecord.outputSchema
      : toOutputSchema(definition.outputSchema);
    const workflowProgram = definition.workflowProgram;
    const executeInput =
      workflowProgram === undefined
        ? undefined
        : (input: unknown) => createWorkflowProgramExecuteInput(workflowProgram, input);

    const resolved: ResolvedToolDefinition = {
      availableInSubagents: definition.availableInSubagents,
      behavior: definition.behavior,
      deferred: definition.deferred,
      description: definition.description,
      execute,
      executeInput,
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
    const marked = isFrameworkTool(resolvedRecord) ? frameworkTool(resolved) : resolved;
    return isInteractionOnly(resolvedRecord.execute) ? markInteractionOnly(marked) : marked;
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

type LabelCallbacks = Exclude<NonNullable<ResolvedToolDefinition["label"]>, false>;

type OptionalResolvedFields = {
  -readonly [K in "label" | "approval" | "endsTurn" | "toModelOutput"]?: ResolvedToolDefinition[K];
};

function extractOptionalHooks(
  record: Record<string, unknown>,
  definition: CompiledToolDefinition,
): OptionalResolvedFields {
  const optional: OptionalResolvedFields = {};

  if (record.label === false) {
    optional.label = false;
  } else if (record.label !== undefined) {
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
            ) as LabelCallbacks["complete"]),
      delta:
        label.delta === undefined
          ? undefined
          : (expectFunction(
              label.delta,
              describe(definition, "to provide an label delta function"),
            ) as LabelCallbacks["delta"]),
      start: expectFunction(
        label.start,
        describe(definition, "to provide a label start callback function"),
      ) as LabelCallbacks["start"],
    };
  }

  if (record.approval !== undefined) {
    optional.approval = normalizeApproval(
      record.approval,
      describe(definition, "to provide a valid approval definition"),
    );
  }

  if (record.endsTurn !== undefined) {
    optional.endsTurn =
      typeof record.endsTurn === "boolean"
        ? record.endsTurn
        : (expectFunction(
            record.endsTurn,
            describe(definition, "to provide endsTurn as a boolean or a function"),
          ) as ResolvedToolDefinition["endsTurn"]);
  }

  if (record.toModelOutput !== undefined) {
    optional.toModelOutput = expectFunction(
      record.toModelOutput,
      describe(definition, "to provide a toModelOutput function"),
    ) as ResolvedToolDefinition["toModelOutput"];
  }

  return optional;
}

function describe(definition: CompiledToolDefinition, predicate: string): string {
  return `Expected the tool export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
