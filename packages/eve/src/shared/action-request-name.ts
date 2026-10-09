import type { RuntimeActionRequest } from "#shared/action-types.js";
import { isObject } from "#shared/guards.js";

/** The tool, agent, or skill a request targets. */
export function actionRequestName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return action.name;
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
    case "tool-call":
    case "workflow-tool-call":
      return action.toolName;
  }
}

/** The skill an `eve__skill` input names, if it names one. */
export function skillTarget(input: unknown): string | undefined {
  return isObject(input) && typeof input.name === "string" ? input.name : undefined;
}
