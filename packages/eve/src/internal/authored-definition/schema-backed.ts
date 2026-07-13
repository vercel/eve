import {
  isDisabledToolSentinel,
  isExperimentalWorkflowToolDefinition,
} from "#public/definitions/tool.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectPositiveInteger,
  expectString,
} from "#internal/authored-module.js";
import type { InternalToolDefinitionWithExecuteFn } from "#shared/tool-definition.js";
import { normalizeJsonSchemaDefinition } from "#internal/json-schema.js";
import {
  isDynamicSentinel,
  rejectDynamicSentinelFallback,
  type DynamicToolEventName,
} from "#shared/dynamic-tool-definition.js";

/**
 * Canonical normalized shape of one authored tool default export.
 *
 * Identity is path-derived — the compiler stamps the filename slug onto
 * the compiled entry. This shape never carries an authored `name`.
 */
type NormalizedAuthoredTool = Readonly<Omit<InternalToolDefinitionWithExecuteFn, "name">>;
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
  | {
      readonly kind: "dynamic-tool";
      readonly eventNames: readonly DynamicToolEventName[];
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
    rejectDynamicSentinelFallback(value, message);
    return {
      kind: "dynamic-tool",
      eventNames: Object.keys(value.events) as DynamicToolEventName[],
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

  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(
    record,
    ["auth", "description", "execute", "inputSchema", "approval", "outputSchema", "toModelOutput"],
    message,
  );
  const inputSchema =
    record.inputSchema === undefined ? null : normalizeJsonSchemaDefinition(record.inputSchema);
  const outputSchema =
    record.outputSchema === undefined
      ? undefined
      : normalizeJsonSchemaDefinition(record.outputSchema, "output");
  const definition: MutableNormalizedAuthoredTool = {
    description: expectString(record.description, message),
    execute: expectFunction(record.execute, message),
    inputSchema,
  };
  if (outputSchema !== undefined) {
    definition.outputSchema = outputSchema;
  }

  /*
   * The compiler runs at build time and only validates that optional hooks
   * (`approval`), when present, have the expected shape. The live
   * references are captured later by `resolve-agent.ts` when it materializes
   * the module export and attaches them to the ResolvedToolDefinition.
   */
  if (record.approval !== undefined) {
    expectFunction(record.approval, message);
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
