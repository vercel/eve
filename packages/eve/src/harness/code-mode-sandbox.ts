import { asSchema, jsonSchema, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "#compiled/zod/index.js";

import { contextStorage } from "#context/container.js";
import { HandleEventKey } from "#context/keys.js";
import { isAuthorizationPendingModelOutput } from "#harness/authorization.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#harness/final-output.js";
import type { HandleEventFn, HarnessToolMap } from "#harness/types.js";
import { createActionResultEvent, createActionsRequestedEvent } from "#protocol/message.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import type { JsonValue } from "#shared/json.js";
import {
  codeModeToolError,
  createCodeModeRuntimeTool,
  renderCodeModeToolSignature,
} from "#shared/code-mode-runtime.js";
import { isValidationFreeToolSchema, toInputSchema, toOutputSchema } from "#tools/schema.js";

/** Model-facing tool name for the experimental code-mode sandbox. */
export const CODE_MODE_TOOL_NAME = "code_mode";

const CATALOG_DESCRIPTION_CHARACTER_LIMIT = 2_000 * 4;
const HIDDEN_SEARCH_TOOL_NAME = "__eve_code_mode_search";

/**
 * Framework tools that never enter the sandbox: control-plane actions
 * (`load_skill` injects instructions, `final_output` ends the run) are model
 * decisions, not data work to script.
 */
const NEVER_SANDBOXED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "connection_search",
  LOAD_SKILL_TOOL_NAME,
  FINAL_OUTPUT_TOOL_NAME,
  "sleep",
  "todo",
  "write_file",
]);

interface CodeModeToolSet {
  readonly modelTools: ToolSet;
}

interface CatalogEntry {
  readonly description: string;
  readonly name: string;
  readonly path: string;
  readonly searchableInput: string;
  readonly signature: string;
}

interface CatalogSearchInput {
  readonly limit?: number;
  readonly offset?: number;
  readonly query?: string;
}

class OutputValidationError extends Error {}

/**
 * Adds one model-facing orchestration option over the request's typed inline
 * tools. Direct tools stay available so the model can choose the cheaper
 * execution shape for each task.
 */
export async function applyCodeModeTool(input: {
  readonly emissionState?: HarnessEmissionState;
  readonly harnessTools: HarnessToolMap;
  readonly tools: ToolSet;
}): Promise<CodeModeToolSet> {
  const hostTools: Record<string, ToolSet[string]> = Object.create(null);
  const modelTools: Record<string, ToolSet[string]> = { ...input.tools };
  const context = contextStorage.getStore();
  const handleEvent = context?.get(HandleEventKey);

  for (const [name, tool] of Object.entries(input.tools)) {
    if (!claimsForCodeMode(name, tool, input.harnessTools)) continue;
    const validatedTool = await validatedCodeModeTool(tool);
    if (validatedTool === null) continue;
    hostTools[name] = wrapHostToolForCodeMode({
      context,
      emissionState: input.emissionState,
      handleEvent,
      name,
      tool: validatedTool,
    });
  }

  const catalog = await createCatalog(hostTools);
  if (catalog.length === 0) return { modelTools: input.tools };
  if (Object.hasOwn(hostTools, HIDDEN_SEARCH_TOOL_NAME)) {
    throw new Error(`Tool name "${HIDDEN_SEARCH_TOOL_NAME}" is reserved by code mode.`);
  }
  hostTools[HIDDEN_SEARCH_TOOL_NAME] = createCatalogSearchTool(catalog);

  const codeModeTool = await createCodeModeRuntimeTool({
    hostTools: hostTools as ToolSet,
    sourcePrefix: `const search = (input = {}) => tools[${JSON.stringify(HIDDEN_SEARCH_TOOL_NAME)}](input);`,
  });
  modelTools[CODE_MODE_TOOL_NAME] = {
    ...codeModeTool,
    description: progressiveCodeModeDescription(catalog),
  } as ToolSet[string];

  return { modelTools: modelTools as ToolSet };
}

async function validatedCodeModeTool(tool: ToolSet[string]): Promise<ToolSet[string] | null> {
  const inputSchema = await executableInputSchema(tool.inputSchema);
  if (inputSchema === null || tool.outputSchema === undefined) return null;
  try {
    if (
      asSchema(tool.outputSchema).validate !== undefined &&
      !isValidationFreeToolSchema(tool.outputSchema)
    ) {
      return { ...tool, inputSchema } as ToolSet[string];
    }
  } catch {
    // Compiled manifests carry plain JSON Schema, which AI SDK asSchema does not accept directly.
  }
  const rawSchema = await resolveSchemaSource(tool.outputSchema);
  const validator = toOutputSchema(rawSchema as never);
  if (
    validator === undefined ||
    validator === null ||
    isValidationFreeToolSchema(validator) ||
    asSchema(validator).validate === undefined
  ) {
    return null;
  }
  const validate = asSchema(validator).validate!;
  const outputSchema = jsonSchema(rawSchema as never, { validate });
  return { ...tool, inputSchema, outputSchema } as ToolSet[string];
}

async function executableInputSchema(
  source: ToolSet[string]["inputSchema"],
): Promise<ToolSet[string]["inputSchema"] | null> {
  try {
    if (asSchema(source).validate !== undefined && !isValidationFreeToolSchema(source)) {
      return source;
    }
  } catch {
    // Rehydrate serialized JSON Schema below.
  }
  const rawSchema = await resolveSchemaSource(source);
  const validator = toInputSchema(rawSchema as never);
  if (
    validator === undefined ||
    validator === null ||
    isValidationFreeToolSchema(validator) ||
    asSchema(validator).validate === undefined
  ) {
    return null;
  }
  return jsonSchema(rawSchema as never, { validate: asSchema(validator).validate! });
}

async function resolveSchemaSource(source: unknown): Promise<unknown> {
  try {
    return await asSchema(source as never).jsonSchema;
  } catch {
    return source;
  }
}

function claimsForCodeMode(
  name: string,
  tool: ToolSet[string],
  harnessTools: HarnessToolMap,
): boolean {
  if (NEVER_SANDBOXED_TOOL_NAMES.has(name) || tool.execute === undefined) return false;
  const harnessTool = harnessTools.get(name);
  if (harnessTool === undefined || harnessTool.runtimeAction !== undefined) return false;
  if (harnessTool.approval !== undefined) return false;
  return harnessTool.execution !== "background" && tool.outputSchema !== undefined;
}

function wrapHostToolForCodeMode(input: {
  readonly context: ReturnType<typeof contextStorage.getStore>;
  readonly emissionState?: HarnessEmissionState;
  readonly handleEvent?: HandleEventFn;
  readonly name: string;
  readonly tool: ToolSet[string];
}): ToolSet[string] {
  const execute = input.tool.execute;
  if (execute === undefined) return input.tool;

  return {
    ...input.tool,
    execute: async (toolInput: never, options: ToolExecutionOptions<never>) => {
      const execution = executeCodeModeHostTool(input, execute, toolInput, options);
      return await execution;
    },
  } as ToolSet[string];
}

async function executeCodeModeHostTool(
  input: Parameters<typeof wrapHostToolForCodeMode>[0],
  execute: NonNullable<ToolSet[string]["execute"]>,
  toolInput: never,
  options: ToolExecutionOptions<never>,
): Promise<unknown> {
  await emitNestedToolRequested(input, options.toolCallId, toolInput);
  const invoke = () => resolveExecuteOutput(execute(toolInput, options));
  let output: unknown;
  try {
    output =
      input.context === undefined
        ? await invoke()
        : await contextStorage.run(input.context, invoke);
    if (isAuthorizationPendingModelOutput(output)) {
      throw await codeModeToolError(
        `Code-mode tool "${input.name}" requires authorization and must be called directly.`,
      );
    }
    output = await validateHostToolOutput(input.name, input.tool, output);
  } catch (error) {
    await emitNestedToolResult(
      input,
      options.toolCallId,
      {
        error:
          error instanceof OutputValidationError
            ? "Nested tool output failed schema validation."
            : "Nested tool execution failed.",
      },
      true,
    );
    throw error;
  }
  await emitNestedToolResult(input, options.toolCallId, normalizeJsonValue(output), false);
  return output;
}

async function validateHostToolOutput(
  name: string,
  tool: ToolSet[string],
  output: unknown,
): Promise<unknown> {
  const validate = asSchema(tool.outputSchema).validate;
  if (validate === undefined) {
    throw new Error(`Code-mode tool "${name}" has no executable output validator.`);
  }
  const result = await validate(output);
  if (!result.success) {
    throw new OutputValidationError(
      `Code-mode tool "${name}" returned output that failed its output schema.`,
    );
  }
  return result.value;
}

async function emitNestedToolRequested(
  input: {
    readonly emissionState?: HarnessEmissionState;
    readonly handleEvent?: HandleEventFn;
    readonly name: string;
  },
  callId: string,
  toolInput: unknown,
): Promise<void> {
  if (input.handleEvent === undefined || input.emissionState === undefined) return;
  await input.handleEvent(
    createActionsRequestedEvent({
      actions: [
        {
          callId,
          input: normalizeJsonValue(toolInput) as Record<string, never>,
          kind: "tool-call",
          toolName: input.name,
        },
      ],
      sequence: input.emissionState.sequence,
      stepIndex: input.emissionState.stepIndex,
      turnId: input.emissionState.turnId,
    }),
  );
}

async function emitNestedToolResult(
  input: {
    readonly emissionState?: HarnessEmissionState;
    readonly handleEvent?: HandleEventFn;
    readonly name: string;
  },
  callId: string,
  output: JsonValue,
  isError: boolean,
): Promise<void> {
  if (input.handleEvent === undefined || input.emissionState === undefined) return;
  await input.handleEvent(
    createActionResultEvent({
      result: {
        callId,
        isError: isError || undefined,
        kind: "tool-result",
        output,
        toolName: input.name,
      },
      sequence: input.emissionState.sequence,
      stepIndex: input.emissionState.stepIndex,
      turnId: input.emissionState.turnId,
    }),
  );
}

function normalizeJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

async function resolveExecuteOutput(output: unknown): Promise<unknown> {
  if (isAsyncIterable(output)) {
    let finalOutput: unknown;
    for await (const part of output) {
      finalOutput = part;
    }
    return finalOutput;
  }
  return await output;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}

async function createCatalog(
  hostTools: Record<string, ToolSet[string]>,
): Promise<readonly CatalogEntry[]> {
  return await Promise.all(
    Object.entries(hostTools)
      .sort(([left], [right]) => compareText(left, right))
      .map(async ([name, tool]) => {
        const inputSchema = await resolveJsonSchema(tool.inputSchema);
        return {
          description: typeof tool.description === "string" ? tool.description : "",
          name,
          path: toolPath(name),
          searchableInput: searchableInputSchemaText(inputSchema),
          signature: await renderCodeModeToolSignature(name, tool),
        };
      }),
  );
}

async function resolveJsonSchema(schema: ToolSet[string]["inputSchema"] | undefined) {
  if (schema === undefined) return null;
  return await asSchema(schema).jsonSchema;
}

function createCatalogSearchTool(entries: readonly CatalogEntry[]) {
  return {
    description: "Internal progressive code-mode catalog search.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      query: z.string().optional(),
    }),
    outputSchema: z.object({
      items: z.array(
        z.object({
          description: z.string(),
          path: z.string(),
          signature: z.string(),
        }),
      ),
      next: z.object({ offset: z.number() }).nullable(),
      remaining: z.number(),
    }),
    execute: async ({ limit = 10, offset = 0, query }: CatalogSearchInput) => {
      const ranked = rankCatalogEntries(entries, query);
      const items = ranked.slice(offset, offset + limit);
      const consumed = Math.min(ranked.length, offset + items.length);
      const remaining = Math.max(0, ranked.length - consumed);
      return {
        items: items.map(({ description, path, signature }) => ({
          description,
          path,
          signature,
        })),
        next: remaining > 0 ? { offset: consumed } : null,
        remaining,
      };
    },
  } as ToolSet[string];
}

function rankCatalogEntries(
  entries: readonly CatalogEntry[],
  query: string | undefined,
): readonly CatalogEntry[] {
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  const tokens = tokenize(normalizedQuery);
  if (tokens.length === 0)
    return [...entries].sort((left, right) => compareText(left.name, right.name));

  return entries
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const description = entry.description.toLowerCase();
      const searchableInput = entry.searchableInput.toLowerCase();
      let score = name === normalizedQuery ? 10_000 : 0;
      for (const token of tokens) {
        if (name === token) score += 100;
        else if (name.includes(token)) score += 40;
        if (description.includes(token)) score += 20;
        if (searchableInput.includes(token)) score += 10;
      }
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || compareText(left.entry.name, right.entry.name),
    )
    .map(({ entry }) => entry);
}

function tokenize(value: string): readonly string[] {
  return value.match(/[a-z0-9]+/g) ?? [];
}

function searchableInputSchemaText(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.description === "string") parts.push(node.description);
    if (isRecord(node.properties)) {
      for (const [name, property] of Object.entries(node.properties)) {
        parts.push(name);
        visit(property);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "description" && key !== "properties") visit(child);
    }
  };
  visit(value);
  return parts.join(" ");
}

function progressiveCodeModeDescription(entries: readonly CatalogEntry[]): string {
  const selected: CatalogEntry[] = [];

  for (const entry of [...entries].sort(compareCatalogEntryLength)) {
    const candidate = [...selected, entry];
    const description = renderProgressiveDescription(entries.length, candidate);
    if (description.length <= CATALOG_DESCRIPTION_CHARACTER_LIMIT) {
      selected.push(entry);
      continue;
    }
    break;
  }

  return renderProgressiveDescription(entries.length, selected);
}

function renderProgressiveDescription(
  totalEntries: number,
  selected: readonly CatalogEntry[],
): string {
  const signatures =
    selected.length === 0
      ? "No signatures fit in the capped listing."
      : [
          "```ts",
          "declare const tools: {",
          ...selected.map((entry) => entry.signature),
          "};",
          "```",
        ].join("\n");
  return [
    "Run a deterministic multi-tool workflow as TypeScript in an isolated sandbox.",
    "",
    "Choose this instead of direct tools when later calls depend on earlier results, the result determines how many calls to make, or loops, filtering, validation, aggregation, or compact local reduction would otherwise require extra model turns.",
    "Use it only when every nested call is read-only or safe to repeat under ordinary tool retry semantics.",
    "Prefer direct tools for one call, a small fixed set of independent calls, or any workflow that needs model judgment or user interaction between calls.",
    "Prefer direct tools for writes, irreversible external effects, approval, or authorization.",
    "Do not wrap a single host call. If you use code_mode, call it once and put the complete deterministic workflow in one program.",
    "",
    "Put the full program in `js`; top-level `await` and `return` work. Return one JSON-serializable result.",
    "Call host tools only through the exact `tools` path shown by this catalog or search. Await every call, or use `Promise.all` for independent calls.",
    "`JSON.parse` and `JSON.stringify` are available. Imports, timers, direct filesystem access, and `fetch` are unavailable.",
    "A program may make at most 64 host calls in total, including catalog searches.",
    "At most 8 host calls may be in flight; split larger fan-outs into bounded parallel batches.",
    "",
    `Progressive catalog: ${totalEntries} tools (${selected.length} shortest signatures listed).`,
    "To discover omitted or related tools, call the in-program lexical `await search({ query?, limit?, offset? })`. Search returns `{ items: [{ path, description, signature }], remaining, next }`; pass `next.offset` as `offset` to continue.",
    'Invoke a result by copying its exact path, for example `await tools.get_weather(input)`. For a dynamic same-program call, derive the flat key with `const key = item.path.startsWith("tools.") ? item.path.slice(6) : JSON.parse(item.path.slice(6, -1)); await tools[key](input);`.',
    "",
    signatures,
  ].join("\n");
}

function compareCatalogEntryLength(left: CatalogEntry, right: CatalogEntry): number {
  return left.signature.length - right.signature.length || compareText(left.name, right.name);
}

function toolPath(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `tools.${name}`
    : `tools[${JSON.stringify(name)}]`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
