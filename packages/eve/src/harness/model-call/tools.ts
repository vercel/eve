import { resolveModelProvider } from "#internal/gateway.js";
import type { ToolSet } from "ai";

import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildFinalOutputTool } from "#harness/final-output.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#protocol/final-output-tool.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { type AnthropicCacheMarker, applyLastToolCacheBreakpoint } from "#harness/prompt-cache.js";
import type { Step } from "#harness/step/context.js";
import { buildToolSetWithProviderTools } from "#harness/tools.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import { requireSessionModelReference } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { toModelSchema } from "#tools/schema.js";

const log = createLogger("harness.tool-loop");

/**
 * Assembles the tools one model call offers: the catalog's listed entries with provider tools in
 * place, and `final_output` when the turn asks for a structured result.
 */
export async function prepareModelTools(
  step: Step,
  input: {
    readonly catalog: StepCatalog;
    readonly model: import("ai").LanguageModel;
    readonly disabledProviderTools?: ReadonlySet<string>;
    readonly generation: GenerationSteering;
    readonly marker: AnthropicCacheMarker | undefined;
  },
): Promise<ToolSet> {
  const { catalog, marker } = input;
  const modelTools = await buildToolSetWithProviderTools({
    describe: catalog.describe,
    disabledProviderTools: input.disabledProviderTools,
    modelProvider: resolveModelProvider(input.model),
    modelReference: requireSessionModelReference(step.session),
    resolve: catalog.resolve,
    tools: catalog.advertised,
  });
  if (step.session.outputSchema !== undefined) {
    modelTools[FINAL_OUTPUT_TOOL_NAME] = buildFinalOutputTool(step.session.outputSchema);
  }

  const effectiveTools = marker ? applyLastToolCacheBreakpoint(modelTools, marker) : modelTools;
  for (const tool of Object.values(effectiveTools)) {
    // Whatever produced this tool, the AI SDK must only receive its own
    // schema type; see toModelSchema.
    tool.inputSchema = toModelSchema(tool.inputSchema, "input");
    if (tool.outputSchema !== undefined) {
      tool.outputSchema = toModelSchema(tool.outputSchema, "output");
    }
    const execute = tool.execute;
    if (execute !== undefined) {
      tool.execute = (...args) => {
        input.generation.protectToolExecution();
        return execute(...args);
      };
    }
  }
  return effectiveTools;
}

/** The entries that can end the turn, with their `endsTurn` option, when `endsTurn` applies. */
export function endsTurnTools(catalog: StepCatalog, applies: boolean): EndsTurnTools {
  if (!applies) return new Map();
  return new Map(
    [...catalog.entries].flatMap(([name, definition]) =>
      definition.endsTurn === undefined || definition.endsTurn === false
        ? []
        : [[name, definition.endsTurn] as const],
    ),
  );
}

/** The names of the entries eve provides, which tracing marks as framework tools. */
export function frameworkToolNames(catalog: StepCatalog): ReadonlySet<string> {
  return new Set(
    [...catalog.advertised.values(), ...catalog.entries.values()]
      .filter((definition) => definition.frameworkTool === true)
      .map((definition) => definition.name),
  );
}

/**
 * Wired as the agent's `onToolExecutionEnd`. On the `tool-error` branch
 * the `error` is still the original throwable (stack/cause intact),
 * unlike the message-only `tool-error` part the model later sees.
 */
export function logToolExecutionError(event: {
  readonly toolCall: { readonly toolName: string; readonly toolCallId: string };
  readonly toolOutput: { readonly type: string; readonly error?: unknown };
}): void {
  // A tool unwinding because its turn was cancelled is the expected outcome
  // of a user action, not a failure worth an error log.
  if (event.toolOutput.type !== "tool-error" || isTurnCancellation(event.toolOutput.error)) {
    return;
  }
  logError(log, "tool execution failed", event.toolOutput.error, {
    toolName: event.toolCall.toolName,
    toolCallId: event.toolCall.toolCallId,
  });
}

export type EndsTurnTools = ReadonlyMap<string, NonNullable<HarnessToolDefinition["endsTurn"]>>;
