import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import { isObject } from "#shared/guards.js";

/** The tool, agent, or skill a request targets. */
export function actionRequestName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return requestedSkill(action);
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
    case "tool-call":
    case "workflow-tool-call":
      return action.toolName;
  }
}

/** The skill a `load-skill` request loads, or the loader itself when its input names none. */
export function requestedSkill(
  action: Extract<RuntimeActionRequest, { readonly kind: "load-skill" }>,
): string {
  return skillTarget(action.input) ?? SKILL_ENTRY_NAME;
}

/** The skill a skill loader's input names, if it names one. */
export function skillTarget(input: unknown): string | undefined {
  return isObject(input) && typeof input.skill === "string" ? input.skill : undefined;
}
