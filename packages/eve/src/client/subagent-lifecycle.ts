import type { MessageStreamEvent } from "#protocol/message.js";
import { isJsonObjectValue } from "#shared/json.js";

/** Parent-stream signals for a child call; child stream boundaries remain independent. */
export type SubagentParentTransition =
  | { readonly type: "called"; readonly callId: string }
  | { readonly type: "background"; readonly callId: string }
  | { readonly type: "completed"; readonly callId: string }
  | { readonly type: "turn-cancelled"; readonly turnId: string };

export function subagentParentTransition(
  event: MessageStreamEvent,
): SubagentParentTransition | undefined {
  switch (event.type) {
    case "subagent.called":
      return { type: "called", callId: event.data.callId };
    case "subagent.completed":
      return {
        type: event.data.backgroundTask === undefined ? "completed" : "background",
        callId: event.data.callId,
      };
    case "turn.cancelled":
      return { type: "turn-cancelled", turnId: event.data.turnId };
    case "action.result": {
      const output = event.data.result.output;
      if (
        event.data.status === "completed" &&
        isJsonObjectValue(output) &&
        output.status === "working" &&
        typeof output.taskId === "string" &&
        typeof output.agentId === "string"
      ) {
        return { type: "background", callId: event.data.result.callId };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
