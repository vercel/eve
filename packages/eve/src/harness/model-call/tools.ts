import type { ToolSet } from "ai";

import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { buildDynamicSubagentTools } from "#context/dynamic-subagent-lifecycle.js";
import { withTaskTools } from "#execution/tasks/model-step.js";
import { getAdvertisedTools } from "#harness/advertised-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildFinalOutputTool, FINAL_OUTPUT_TOOL_NAME } from "#harness/final-output.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applyLastToolCacheBreakpoint } from "#harness/prompt-cache.js";
import type { Step } from "#harness/step/context.js";
import { buildToolSetFromDefinitions, buildToolSetWithProviderTools } from "#harness/tools.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import type { HarnessToolMap } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { toModelSchema } from "#tools/schema.js";

const log = createLogger("harness.tool-loop");

/** The tools one model call offers, and the views of them the step reads afterwards. */
export interface ModelTools {
  /** What the AI SDK receives. */
  readonly effectiveTools: ToolSet;
  readonly modelTools: ToolSet;
  /** Every tool the model can call, by name, for presenting its calls. */
  readonly presentationTools: HarnessToolMap;
  /** The advertised harness tools; they decide which calls defer to the runtime. */
  readonly coordinationTools: HarnessToolMap;
  /** Tools that can end the turn, with their `endsTurn` option. */
  readonly endsTurnTools: EndsTurnTools;
}

/**
 * Assembles the tools one model call offers: authored and dynamic subagent tools, task tools,
 * provider tools, dynamic tools (which override a same-named authored tool), and `final_output`
 * when the turn asks for a structured result.
 */
export async function prepareModelTools(
  step: Step,
  input: {
    readonly approvedTools: ReadonlySet<string>;
    readonly disabledProviderTools?: ReadonlySet<string>;
    readonly generation: GenerationSteering;
    readonly profile: ModelProfile;
  },
): Promise<ModelTools> {
  const { ctx } = step;
  const { approvedTools, disabledProviderTools, profile } = input;
  const coordinationTools = withTaskTools(
    getAdvertisedTools({
      session: step.session,
      tools: buildHarnessToolsWithDynamicSubagents(step.config.tools, ctx),
    }),
  );

  const flatTools = await buildToolSetWithProviderTools({
    approvedTools,
    disabledProviderTools,
    profile,
    tools: coordinationTools,
  });

  // Stream emitters resolve label callbacks by tool name, so they need the
  // dynamic tools the model can call, not only the authored ones.
  const presentationTools = new Map(coordinationTools);
  if (ctx !== undefined) {
    const dynamicTools = getAdvertisedTools({
      session: step.session,
      tools: buildDynamicTools(ctx),
    });
    const dynamicToolSet = buildToolSetFromDefinitions({
      approvedTools,
      disabledProviderTools,
      tools: dynamicTools,
    });
    for (const [name, toolDefinition] of Object.entries(dynamicToolSet)) {
      if (coordinationTools.get(name)?.workflowId !== undefined) {
        throw new Error(
          `Dynamic tool "${name}" collides with a coordination-visible deferred tool.`,
        );
      }
      flatTools[name] = toolDefinition;
    }
    // Match `buildToolSetFromDefinitions`: the first dynamic definition of a
    // name (step, then turn, then session) wins, and still overrides authored.
    const presentedDynamicNames = new Set<string>();
    for (const tool of dynamicTools) {
      if (presentedDynamicNames.has(tool.name)) continue;
      presentedDynamicNames.add(tool.name);
      presentationTools.set(tool.name, tool);
    }
  }

  if (step.session.outputSchema !== undefined) {
    flatTools[FINAL_OUTPUT_TOOL_NAME] = buildFinalOutputTool(step.session.outputSchema);
  }

  const advertised = await getAdvertisedTools({
    modelTools: flatTools,
    session: step.session,
    tools: coordinationTools,
  });
  step.session = advertised.session;
  const { modelTools } = advertised;
  // `endsTurn` applies only in root, unstructured turns. Only a literal
  // `true` is described to the model; a function decides from each result.
  const endsTurnTools = new Map<string, NonNullable<HarnessToolDefinition["endsTurn"]>>();
  if (!step.hasDelegatedCaller && step.session.outputSchema === undefined) {
    for (const [name, modelTool] of Object.entries(modelTools)) {
      const endsTurn = presentationTools.get(name)?.endsTurn;
      if (modelTool.type === "provider" || endsTurn === undefined || endsTurn === false) continue;
      endsTurnTools.set(name, endsTurn);
      if (endsTurn === true) {
        modelTool.description =
          `${modelTool.description ?? ""}\n\n${ENDS_TURN_TOOL_NOTE}`.trimStart();
      }
    }
  }

  const effectiveTools = profile.anthropicCache
    ? applyLastToolCacheBreakpoint(modelTools)
    : modelTools;
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

  step.frameworkToolNames = new Set(
    [...presentationTools].filter(([, tool]) => tool.frameworkTool === true).map(([name]) => name),
  );
  return { coordinationTools, effectiveTools, endsTurnTools, modelTools, presentationTools };
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

function buildHarnessToolsWithDynamicSubagents(
  tools: HarnessToolMap,
  ctx: Parameters<typeof buildDynamicSubagentTools>[0] | undefined,
): HarnessToolMap {
  const effectiveTools = new Map(tools);
  if (ctx === undefined) return effectiveTools;
  for (const dynamicSubagent of buildDynamicSubagentTools(ctx)) {
    if (effectiveTools.has(dynamicSubagent.name)) {
      throw new Error(
        `Dynamic subagent "${dynamicSubagent.name}" collides with another runtime-visible tool name.`,
      );
    }
    effectiveTools.set(dynamicSubagent.name, dynamicSubagent);
  }
  return effectiveTools;
}

/** Appended to the model-facing description of every tool with `endsTurn: true`. */
export const ENDS_TURN_TOOL_NOTE =
  "Calling this tool ends your turn once it succeeds: do not write a reply or call other tools in the same step. If it fails, you will see the error and can continue.";

export type EndsTurnTools = ReadonlyMap<string, NonNullable<HarnessToolDefinition["endsTurn"]>>;
