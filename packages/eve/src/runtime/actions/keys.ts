import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";

/**
 * Returns the stable match key used to pair one pending runtime action request
 * with its resume result.
 */
export function getRuntimeActionRequestKey(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return `runtime-action:${action.kind}:${action.callId}`;
    case "remote-agent-call":
      return `subagent-call:${action.remoteAgentName}:${action.callId}`;
    case "subagent-call":
      return `subagent-call:${action.subagentName}:${action.callId}`;
    case "tool-call":
      return `tool-call:${action.toolName}:${action.callId}`;
  }
}

/**
 * Returns the stable match key used to pair one runtime action result with its
 * originating request.
 */
export function getRuntimeActionResultKey(result: RuntimeActionResult): string {
  switch (result.kind) {
    case "load-skill-result":
      return `runtime-action:load-skill:${result.callId}`;
    case "subagent-result":
      return `subagent-call:${result.subagentName}:${result.callId}`;
    case "tool-result":
      return `tool-call:${result.toolName}:${result.callId}`;
  }
}
