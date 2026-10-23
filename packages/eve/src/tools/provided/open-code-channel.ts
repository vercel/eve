import {
  defineWorkflowTool,
  toolOutput,
  type ToolModelOutput,
  type WorkflowExecuteToolDefinition,
} from "#public/tools/index.js";
import { executeOpenCodeChannel } from "#tools/provided/open-code-channel-workflow.js";
import { frameworkTool } from "#tools/provided/framework-tool.js";
import { defineJsonSchema } from "#tools/schema.js";

const OPEN_CODE_CHANNEL_DESCRIPTION = [
  "Move this Slack conversation into a new code channel: a dedicated channel for one task, where you continue the work with the conversation so far.",
  "",
  "Usage:",
  "- Open one for multi-step work: code changes, builds, tests, pull requests, investigations, or long output.",
  "- Answer in place when one message answers the request.",
  "- Call it once per request. Slack links the new channel in this thread, so after it opens, reply here in one short sentence at most.",
  '- If the status is "unavailable" or Slack refuses, continue here and tell the person why; don\'t retry.',
].join("\n");

export interface OpenCodeChannelInput {
  message: string;
  name: string;
}

export type OpenCodeChannelOutput =
  | { sessionId: string; status: "opened" }
  | { reason: string; status: "unavailable" };

const OPEN_CODE_CHANNEL_INPUT_SCHEMA = defineJsonSchema<OpenCodeChannelInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description:
        "The first message of the code channel's session: the task and where to start. It sees the conversation so far.",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "Short title for the channel, such as `Fix the flaky login test`.",
    },
  },
  required: ["message", "name"],
  additionalProperties: false,
});

const OPEN_CODE_CHANNEL_OUTPUT_SCHEMA = defineJsonSchema<OpenCodeChannelOutput>({
  oneOf: [
    {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        status: { type: "string", const: "opened" },
      },
      required: ["sessionId", "status"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        reason: { type: "string" },
        status: { type: "string", const: "unavailable" },
      },
      required: ["reason", "status"],
      additionalProperties: false,
    },
  ],
});

// The model reads a plain result better than JSON, and must not open or link the channel twice.
function toOpenCodeChannelModelOutput(output: OpenCodeChannelOutput): ToolModelOutput {
  return output.status === "opened"
    ? toolOutput.text(
        "Opened the code channel, and Slack linked it in this thread. The work continues there with the conversation so far. Don't call open_code_channel again for this request.",
      )
    : toolOutput.text(
        `No code channel opened: ${output.reason} Continue here, and don't retry open_code_channel.`,
      );
}

/**
 * Defines the `open_code_channel` tool, which forks a Slack conversation into
 * a new Slack code channel. The code channel's session starts with the
 * conversation so far as history. It goes through the Slack channel that
 * serves the calling session, which needs `codeChannels: true`.
 *
 * Export it from `agent/tools/open_code_channel.ts`:
 *
 * ```ts
 * import { openCodeChannel } from "eve/tools/open_code_channel";
 *
 * export default openCodeChannel();
 * ```
 */
export function openCodeChannel(): WorkflowExecuteToolDefinition<
  OpenCodeChannelInput,
  OpenCodeChannelOutput
> {
  return frameworkTool(
    defineWorkflowTool({
      // `ctx.sendToChannel()` reaches channels only from the root agent.
      availableInSubagents: false,
      description: OPEN_CODE_CHANNEL_DESCRIPTION,
      execute: executeOpenCodeChannel,
      inputSchema: OPEN_CODE_CHANNEL_INPUT_SCHEMA,
      outputSchema: OPEN_CODE_CHANNEL_OUTPUT_SCHEMA,
      toModelOutput: toOpenCodeChannelModelOutput,
    }),
  );
}
