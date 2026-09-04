import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";
import { readWorkflowFunctionId } from "#internal/workflow/reference.js";
import { isDisabledToolSentinel } from "#tools/definition.js";
import { isExperimentalWorkflowToolDefinition } from "#tools/workflow.js";
import { isWebSearchToolDefinition } from "#tools/provided/web-search.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectPositiveInteger,
  expectString,
} from "#internal/authored-module.js";
import type { InternalToolDefinition, ToolExecuteFn } from "#tools/definition.js";
import { readToolBehavior, type CompiledToolBehavior } from "#tools/behavior.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";
import { normalizeApproval } from "#internal/authored-definition/approval.js";
import { shouldRebindDynamicCallbacks } from "#internal/dynamic-tool-rebind.js";
import {
  assertResolverOnlyDynamicSentinel,
  isDynamicSentinel,
  type DynamicToolEventName,
} from "#dynamic/definition.js";

/**
 * Canonical normalized shape of one authored tool default export.
 *
 * Identity is path-derived — the compiler stamps the filename slug onto
 * the compiled entry. This shape never carries an authored `name`.
 */
type NormalizedAuthoredTool = Readonly<
  Omit<InternalToolDefinition, "name"> & {
    readonly behavior?: CompiledToolBehavior;
    readonly execute?: ToolExecuteFn;
    readonly hasApproval: boolean;
    readonly hasExecute: boolean;
    readonly hasModelOutputProjection: boolean;
  }
>;
type MutableNormalizedAuthoredTool = {
  -readonly [K in keyof NormalizedAuthoredTool]: NormalizedAuthoredTool[K];
};

/**
 * Result of normalizing one authored tool default export. Either a real tool
 * definition, a sentinel that disables a framework default, or a dynamic
 * tool resolver. In all cases the disable target / runtime name is the
 * authored file's slug, supplied by the compiler — this layer never sees
 * a name.
 */
type NormalizedToolEntry =
  | { readonly kind: "tool"; readonly definition: NormalizedAuthoredTool }
  | { readonly kind: "disabled" }
  | { readonly kind: "workflow-tool"; readonly maxSubagents?: number }
  | { readonly kind: "web-search-tool"; readonly provider: "exa" | "parallel" }
  | {
      readonly kind: "dynamic-tool";
      readonly eventNames: readonly DynamicToolEventName[];
      readonly rebindMissingCallbacks: boolean;
    };

/**
 * Normalizes one authored tool default export. Recognizes real tool
 * definitions (`defineTool(...)`), disable sentinels (`disableTool()`), and the
 * experimental `Workflow` tool definition.
 *
 * Authored `name` fields are rejected — tool identity is path-derived.
 */
export function normalizeToolDefinition(value: unknown, message: string): NormalizedToolEntry {
  if (isDynamicSentinel(value)) {
    assertResolverOnlyDynamicSentinel(value, message);
    return {
      kind: "dynamic-tool",
      eventNames: Object.keys(value.events) as DynamicToolEventName[],
      rebindMissingCallbacks: shouldRebindDynamicCallbacks(value),
    };
  }
  if (isDisabledToolSentinel(value)) {
    return { kind: "disabled" };
  }
  if (isExperimentalWorkflowToolDefinition(value)) {
    const record = expectObjectRecord(value, message);
    expectOnlyKnownKeys(record, ["kind", "maxSubagents"], message);
    return {
      kind: "workflow-tool",
      maxSubagents:
        record.maxSubagents === undefined
          ? undefined
          : expectPositiveInteger(record.maxSubagents, message),
    };
  }
  if (isWebSearchToolDefinition(value)) {
    const record = expectObjectRecord(value, message);
    expectOnlyKnownKeys(record, ["kind", "provider"], message);
    const provider = expectString(record.provider, message);
    if (provider !== "exa" && provider !== "parallel") {
      throw new Error(`${message} Expected "provider" to be one of: exa, parallel.`);
    }
    return { kind: "web-search-tool", provider };
  }

  const record = expectObjectRecord(value, message);
  const workflowId = readWorkflowFunctionId(record.execute);
  if (isWorkflowToolDefinition(value)) {
    if (workflowId === undefined) {
      throw new Error(
        `${message} defineWorkflowTool() requires a compiled workflow executor. Start execute with "use workflow" and export defineWorkflowTool() as the default export of a static tool module.`,
      );
    }
  } else if (workflowId !== undefined) {
    throw new Error(
      `${message} Workflow executors require defineWorkflowTool() from "eve/tools". Replace defineTool() or the bare tool object with defineWorkflowTool().`,
    );
  }
  expectOnlyKnownKeys(
    record,
    [
      "label",
      "auth",
      "description",
      "execute",
      "execution",
      "inputSchema",
      "approval",
      "outputSchema",
      "toModelOutput",
    ],
    message,
  );
  const inputSchema =
    record.inputSchema === undefined
      ? null
      : serializeInputSchema(record.inputSchema as ToolSchemaSource);
  const outputSchema = serializeOutputSchema(record.outputSchema as ToolSchemaSource | undefined);
  const behavior = readToolBehavior(value);
  const hasExecute = record.execute !== undefined;
  if (
    !hasExecute &&
    behavior?.handling?.kind !== "dispatch" &&
    behavior?.handling?.kind !== "request-input"
  ) {
    expectFunction(record.execute, message);
  }
  const definition: MutableNormalizedAuthoredTool = {
    description: expectString(record.description, message),
    hasApproval: record.approval !== undefined,
    hasExecute,
    hasModelOutputProjection: record.toModelOutput !== undefined,
    inputSchema,
  };
  if (behavior !== undefined) {
    definition.behavior = behavior;
  }
  if (hasExecute) {
    definition.execute = expectFunction(record.execute, message) as ToolExecuteFn;
  }
  if (record.execution !== undefined) {
    if (!hasExecute) {
      throw new Error(`${message} Execute-less native tools cannot use background execution.`);
    }
    const execution = expectString(record.execution, message);
    if (execution !== "background") {
      throw new Error(`${message} Expected "execution" to be "background".`);
    }
    definition.execution = execution;
  }
  if (outputSchema !== undefined) {
    definition.outputSchema = outputSchema;
  }

  /*
   * The compiler runs at build time and only validates that optional hooks
   * (`approval`), when present, have the expected shape. The live
   * references are captured later by `resolve-agent.ts` when it materializes
   * the module export and attaches them to the ResolvedToolDefinition.
   */
  if (record.label !== undefined) {
    const label = expectObjectRecord(record.label, message);
    expectOnlyKnownKeys(label, ["start", "complete", "delta"], message);
    expectFunction(label.start, message);
    if (label.complete !== undefined) expectFunction(label.complete, message);
    if (label.delta !== undefined) expectFunction(label.delta, message);
  }

  if (record.approval !== undefined) {
    normalizeApproval(record.approval, message);
  }

  if (record.toModelOutput !== undefined) {
    expectFunction(record.toModelOutput, message);
  }

  if (record.auth !== undefined) {
    const auth = expectObjectRecord(record.auth, message);
    expectFunction(auth.getToken, message);
  }

  return {
    kind: "tool",
    definition,
  };
}
