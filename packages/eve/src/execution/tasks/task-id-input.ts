import {
  AGENT_SERVE_TOOL_DESCRIPTION,
  SERVE_TOOL_DESCRIPTION,
  TASK_ID_INPUT_DESCRIPTION,
} from "#execution/tasks/render.js";
import { isAgentTool } from "#execution/tasks/tool-entry-point.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { JsonObject } from "#shared/json.js";
import { isToolSchema, withOptionalStringProperty } from "#tools/schema.js";

// A `serve` tool's model input is the tool's own input plus an optional
// `taskId`, which sends the call to the running task it names.

/** The model input property eve adds to every `serve` tool. */
export const TASK_ID_INPUT = "taskId";

/** The tool as the model sees it: its input gains `taskId`, and its description explains it. */
export function withTaskIdInput(definition: HarnessToolDefinition): HarnessToolDefinition {
  const schema = definition.inputSchema;
  if (!isToolSchema(schema)) {
    throw new Error(`Tool "${definition.name}" has no input schema eve can add taskId to.`);
  }
  const sentence = isAgentTool(definition) ? AGENT_SERVE_TOOL_DESCRIPTION : SERVE_TOOL_DESCRIPTION;
  return {
    ...definition,
    description: appendSentence(definition.description, sentence),
    inputSchema: withOptionalStringProperty(schema, {
      description: TASK_ID_INPUT_DESCRIPTION,
      name: TASK_ID_INPUT,
    }),
  };
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
