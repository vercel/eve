import type { ModelOption } from "#models/options.js";
import {
  agentModelsServeWorkflow,
  type AgentModelsToolInput,
} from "#runtime/subagents/workflow.js";
import { attachAgentToolModels, parseAgentToolModels } from "#tools/agent-models.js";
import { agent as agentTool } from "#tools/framework/agent.js";
import { frameworkTool } from "#tools/provided/framework-tool.js";
import { defineJsonSchema } from "#tools/schema.js";
import {
  defineWorkflowTool,
  type WorkflowServeToolDefinition,
} from "#tools/workflow-definition.js";

export type { AgentModelsToolInput };

/** The default `agent` tool: delegates to a copy of the root agent on its current model. */
export type AgentTool = typeof agentTool;

/** An `agent({ models })` tool: the model may run each new task on one of the listed models. */
export type AgentModelsTool = WorkflowServeToolDefinition<AgentModelsToolInput, unknown>;

/** One model an `agent({ models })` tool offers. */
export type AgentToolModel = ModelOption;

export interface AgentToolOptions<
  TModels extends Readonly<Record<string, AgentToolModel>> = Readonly<
    Record<string, AgentToolModel>
  >,
> {
  /**
   * Models a task may run on, by key. The model sees each key and its description. A string
   * entry is the description, and its key is the AI Gateway model ID. An object entry holds
   * the model, an AI Gateway model ID or a live AI SDK model, with its description and
   * optional `reasoning`, `modelContextWindowTokens`, and `modelOptions`.
   */
  readonly models?: TModels;
}

/**
 * The root agent's `agent` tool, which delegates a subtask to a copy of the root agent.
 *
 * Re-export the default to keep it, or call `agent({ models })` to let the model run each new
 * task on one of the listed models:
 *
 * ```ts
 * // agent/tools/agent.ts
 * import { agent } from "eve/tools/agent";
 * import { anthropic } from "@ai-sdk/anthropic";
 *
 * export default agent({
 *   models: {
 *     "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
 *     haiku: { model: anthropic("claude-haiku-5"), description: "Cheap lookups" },
 *   },
 * });
 * ```
 *
 * A call that omits `model` runs on the current model, and without `models` the model sees no
 * model option. A task keeps the model it started with. Subagents never get this tool.
 */
export function agent(): AgentTool;
export function agent(options: AgentToolOptions & { readonly models?: undefined }): AgentTool;
export function agent<const TModels extends Readonly<Record<string, AgentToolModel>>>(
  options: AgentToolOptions<TModels> & { readonly models: TModels },
): AgentModelsTool;
export function agent(options: AgentToolOptions = {}): AgentTool | AgentModelsTool {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("agent options must be an object.");
  }
  const unknownKeys = Object.keys(options).filter((key) => key !== "models");
  if (unknownKeys.length > 0) {
    throw new TypeError(`agent options do not support ${unknownKeys.join(", ")}.`);
  }
  if (options.models === undefined) return agentTool;
  const models = parseAgentToolModels(options.models);
  const keys = [...models.keys()];
  const choices = [...models.values()]
    .map((option) => `${JSON.stringify(option.key)}: ${option.description}`)
    .join("\n");
  const inputSchema = defineJsonSchema<AgentModelsToolInput>({
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to send to the agent, with everything it needs to do the work.",
      },
      model: {
        type: "string",
        enum: keys,
        description: `Model for a new task. Omit it to use your current model. When continuing a task, omit it or use the task's original model. Models:\n${choices}`,
      },
    },
    required: ["message"],
    additionalProperties: false,
  });
  return attachAgentToolModels(
    frameworkTool(
      defineWorkflowTool({
        // Choosing a model is the root session's decision; subagents never get this tool.
        availableInSubagents: false,
        description: [
          "Delegate a focused subtask to a copy of yourself, optionally on another model.",
          "Each call starts a task, so start independent tasks before waiting for them.",
          "A task keeps the model it started with.",
          "In message, state the goal, what to return, and whether it may change files.",
        ].join(" "),
        inputSchema,
        serve: agentModelsServeWorkflow,
      }),
    ),
    models,
  );
}

export default agentTool;
