import {
  AGENT_SERVE_TOOL_DESCRIPTION,
  SERVE_TOOL_DESCRIPTION,
  TASK_ID_INPUT_DESCRIPTION,
} from "#execution/tasks/render.js";
import { isAgentTool } from "#execution/tasks/tool-entry-point.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { displayTitle } from "#shared/display-name.js";
import type { JsonObject } from "#shared/json.js";
import { firstSentence } from "#shared/presentation-text.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import { isToolSchema, type ToolSchema, withOptionalStringProperty } from "#tools/schema.js";

// A `serve` tool's model input is the tool's own input plus an optional
// `taskId`, which sends the call to the running task it names.

/** The model input property eve adds to every `serve` tool. */
export const TASK_ID_INPUT = "taskId";

/** A `serve` tool's input schema as the model sees it, with the optional `taskId`. */
export function withTaskIdSchema(schema: ToolSchema): ToolSchema {
  return withOptionalStringProperty(schema, {
    description: TASK_ID_INPUT_DESCRIPTION,
    name: TASK_ID_INPUT,
  });
}

/**
 * The tool as the model sees it: its input gains `taskId`, and its description
 * explains it. An agent tool also gets its activity label, the agent and the
 * first sentence of its message: `Researcher: Find the March incidents`.
 */
export function withTaskIdInput(definition: HarnessToolDefinition): HarnessToolDefinition {
  const schema = definition.inputSchema;
  if (!isToolSchema(schema)) {
    throw new Error(`Tool "${definition.name}" has no input schema eve can add taskId to.`);
  }
  const agent = isAgentTool(definition);
  const described: HarnessToolDefinition = {
    ...definition,
    description: appendSentence(
      definition.description,
      agent ? AGENT_SERVE_TOOL_DESCRIPTION : SERVE_TOOL_DESCRIPTION,
    ),
    inputSchema: withTaskIdSchema(schema),
  };
  if (!agent || definition.label?.start !== undefined) return described;
  return {
    ...described,
    label: { ...definition.label, start: (input) => agentCallLabel(definition.name, input) },
  };
}

/**
 * `Researcher: Find the March incidents`, from the first sentence of the
 * message. A call to the agent's own copy shows the brief alone, since its
 * name, `agent`, says nothing. The agent's name when the message is empty.
 */
function agentCallLabel(name: string, input: unknown): string {
  const message =
    typeof input === "object" && input !== null
      ? (input as { message?: unknown }).message
      : undefined;
  const brief = typeof message === "string" ? firstSentence(message) : undefined;
  if (brief === undefined) return displayTitle(name);
  return name === AGENT_TOOL_NAME ? brief : `${displayTitle(name)}: ${brief}`;
}

/** A `serve` tool call's model input, split into the task it names and the tool's own input. */
export interface ServeCallInput {
  readonly input: JsonObject;
  readonly taskId?: string;
}

export function splitTaskIdInput(modelInput: JsonObject): ServeCallInput {
  const { [TASK_ID_INPUT]: taskId, ...input } = modelInput;
  if (typeof taskId !== "string") return { input };
  return { input, taskId };
}

function appendSentence(description: string, sentence: string): string {
  const trimmed = description.trimEnd();
  if (trimmed === "") return sentence;
  return `${trimmed} ${sentence}`;
}
