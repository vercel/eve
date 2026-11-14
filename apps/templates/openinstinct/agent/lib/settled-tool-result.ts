import { call, type CallSettled, type SessionView } from "eve/events";

/**
 * Rebuilds the completed tool result a channel delivers from a v27
 * `call.settled` event. The event carries only the call ID, so the tool name
 * comes from the session view's `call.requested` record.
 */
export function settledToolResult(event: CallSettled, view: SessionView) {
  if (event.data.outcome !== "completed") return undefined;
  const settled = call(view, event.data.callId);
  if (settled?.kind !== "tool") return undefined;
  return {
    kind: "tool-result" as const,
    output: event.data.output,
    toolName: settled.name,
  };
}
