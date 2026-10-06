import {
  isWorkflowToolDefinition,
  readWorkflowToolEntryPoints,
  type WorkflowToolEntryPoint,
} from "#tools/workflow-definition.js";
import { readWorkflowFunctionId } from "#internal/workflow/reference.js";
import { TASK_ID_INPUT, withTaskIdSchema } from "#execution/tasks/task-id-input.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import { isDisabledToolSentinel } from "#tools/definition.js";
import { isWebSearchToolDefinition } from "#tools/provided/web-search.js";
import type { WebSearchProvider } from "#shared/web-search.js";
import {
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import type { InternalToolDefinition, ToolExecuteFn } from "#tools/definition.js";
import { readToolBehavior, type CompiledToolBehavior } from "#tools/behavior.js";
import {
  readWorkflowProgramOptions,
  type WorkflowProgramOptions,
} from "#tools/workflow-program-input.js";
import {
  serializeInputSchema,
  serializeModelInputSchema,
  serializeOutputSchema,
  toInputSchema,
  type ToolSchemaSource,
  UNSPECIFIED_INPUT_SCHEMA,
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
    /** The input schema as eve sends it to a model, from the live authored schema. */
    readonly modelInputSchema: JsonObject;
    readonly workflow?: CompiledWorkflowEntry;
    readonly workflowProgram?: WorkflowProgramOptions;
  }
>;

/** The compiled entry point of a `defineWorkflowTool()` definition. */
interface CompiledWorkflowEntry {
  readonly entryPoint: WorkflowToolEntryPoint;
  readonly workflowId: string;
}
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
  | { readonly kind: "web-search-tool"; readonly provider: WebSearchProvider }
  | {
      readonly kind: "dynamic-tool";
      readonly eventNames: readonly DynamicToolEventName[];
      readonly rebindMissingCallbacks: boolean;
    };

/**
 * Normalizes one authored tool default export. Recognizes real tool
 * definitions (`defineTool(...)`), disable sentinels (`disableTool()`), and the
 * provider-managed web-search definitions.
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
  if (isWebSearchToolDefinition(value)) {
    const record = expectObjectRecord(value, message);
    expectOnlyKnownKeys(record, ["kind", "provider"], message);
    const provider = expectString(record.provider, message);
    if (provider !== "exa" && provider !== "parallel" && provider !== "browserbase") {
      throw new Error(`${message} Expected "provider" to be one of: exa, parallel, browserbase.`);
    }
    return { kind: "web-search-tool", provider };
  }

  const record = expectObjectRecord(value, message);
  const workflow = isWorkflowToolDefinition(value)
    ? readCompiledWorkflowEntry(record, message)
    : undefined;
  if (workflow === undefined && readWorkflowFunctionId(record.execute) !== undefined) {
    throw new Error(
      `${message} Workflow executors require defineWorkflowTool() from "eve/tools". Replace defineTool() or the bare tool object with defineWorkflowTool().`,
    );
  }
  if (workflow !== undefined && record.endsTurn !== undefined) {
    throw new Error(
      `${message} "endsTurn" is not supported on defineWorkflowTool(). Workflow tools resume the turn when they finish; use defineTool() for a tool that ends the turn.`,
    );
  }
  expectOnlyKnownKeys(
    record,
    [
      "availableInSubagents",
      "endsTurn",
      "label",
      "auth",
      "description",
      "execute",
      "inputSchema",
      "approval",
      "approvalKey",
      "outputSchema",
      "toModelOutput",
      ...(workflow === undefined ? [] : [workflow.entryPoint]),
    ],
    message,
  );
  const inputSchema =
    record.inputSchema === undefined
      ? null
      : serializeInputSchema(record.inputSchema as ToolSchemaSource);
  if (workflow?.entryPoint === "serve") assertNoOwnTaskIdInput(inputSchema, message);
  const outputSchema = serializeOutputSchema(record.outputSchema as ToolSchemaSource | undefined);
  const behavior = readToolBehavior(value);
  const workflowProgram = readWorkflowProgramOptions(value);
  // A workflow tool's entry point is its executor; the runtime loads the module for its hooks.
  const hasExecute = workflow !== undefined || record.execute !== undefined;
  if (!hasExecute && behavior?.handling?.kind !== "dispatch") {
    expectFunction(record.execute, message);
  }
  const definition: MutableNormalizedAuthoredTool = {
    availableInSubagents:
      record.availableInSubagents === undefined
        ? undefined
        : expectBoolean(record.availableInSubagents, message),
    description: expectString(record.description, message),
    endsTurn:
      record.endsTurn === undefined || typeof record.endsTurn === "boolean"
        ? record.endsTurn
        : (expectFunction(record.endsTurn, message) as (
            output: unknown,
          ) => boolean | Promise<boolean>),
    hasApproval: record.approval !== undefined,
    hasExecute,
    hasModelOutputProjection: record.toModelOutput !== undefined,
    inputSchema,
    modelInputSchema: modelInputSchemaOf(
      record.inputSchema,
      // An agent dispatch runs as a `serve` task, as a `serve` workflow tool does.
      workflow?.entryPoint === "serve" || behavior?.handling?.kind === "dispatch",
    ),
  };
  if (behavior !== undefined) {
    definition.behavior = behavior;
  }
  if (workflowProgram !== undefined) {
    definition.workflowProgram = workflowProgram;
  }
  if (workflow !== undefined) {
    definition.workflow = workflow;
  } else if (hasExecute) {
    definition.execute = expectFunction(record.execute, message) as ToolExecuteFn;
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

  if (record.approvalKey !== undefined) {
    expectFunction(record.approvalKey, message);
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

/** Reads the one entry point `defineWorkflowTool()` accepted, which the build compiled to a workflow. */
function readCompiledWorkflowEntry(
  record: Record<string, unknown>,
  message: string,
): CompiledWorkflowEntry {
  const [entryPoint] = readWorkflowToolEntryPoints(record);
  const workflowId =
    entryPoint === undefined ? undefined : readWorkflowFunctionId(record[entryPoint]);
  if (entryPoint === undefined || workflowId === undefined) {
    throw new Error(
      `${message} defineWorkflowTool() requires a compiled workflow executor. Start execute, task, or serve with "use workflow" and export defineWorkflowTool() as the default export of a static tool module.`,
    );
  }
  return { entryPoint, workflowId };
}

/**
 * Only the live authored schema tells whether eve closes its objects for the
 * model, so the model-facing form is captured while the module is loaded.
 */
function modelInputSchemaOf(source: unknown, serve: boolean): JsonObject {
  const schema = toInputSchema(source as ToolSchemaSource | undefined) ?? UNSPECIFIED_INPUT_SCHEMA;
  return serializeModelInputSchema(serve ? withTaskIdSchema(schema) : schema);
}

/** eve adds `taskId` to a `serve` tool's model input, so the tool's own input can't use it. */
function assertNoOwnTaskIdInput(inputSchema: JsonObject | null, message: string): void {
  const properties = inputSchema?.properties;
  if (!isObject(properties) || !(TASK_ID_INPUT in properties)) return;
  throw new Error(
    `${message} inputSchema declares "${TASK_ID_INPUT}", which eve adds to a serve tool's model input to send a call to a running task. Rename the field.`,
  );
}
