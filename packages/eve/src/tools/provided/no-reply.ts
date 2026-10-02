import { defineTool, type ToolDefinition } from "#public/tools/index.js";

const NO_REPLY_TOOL_DESCRIPTION =
  "End your turn without sending a reply. Use this when nothing needs to be said, such as when a scheduled check finds nothing to report or an action you already took is the whole answer.";

export interface NoReplyToolInput {
  reason?: string;
}

/**
 * Defines the opt-in `no_reply` tool, which ends the turn without a reply.
 *
 * Export it from `agent/tools/no_reply.ts`:
 *
 * ```ts
 * import { noReply } from "eve/tools/no_reply";
 *
 * export default noReply();
 * ```
 *
 * A turn that ends with `no_reply` completes without a final message, so
 * channels and schedules post nothing. Only root sessions receive it.
 */
export function noReply(): ToolDefinition<NoReplyToolInput, string> {
  return defineTool<NoReplyToolInput, string>({
    availableInSubagents: false,
    description: NO_REPLY_TOOL_DESCRIPTION,
    endsTurn: true,
    execute: () => "No reply was sent.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Why no reply is needed. Kept in the session history and traces; never sent.",
        },
      },
      additionalProperties: false,
    },
  });
}
