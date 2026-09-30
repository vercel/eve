import type { RuntimeActionRequest } from "#shared/action-types.js";

/** The tool, agent, or `load_skill` a request targets. */
export function actionRequestName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return "load_skill";
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
    case "tool-call":
    case "workflow-tool-call":
      return action.toolName;
  }
}
