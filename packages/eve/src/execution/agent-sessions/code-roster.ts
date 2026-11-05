import { type CodeAgent, runtimeNodeId } from "#runtime/sessions/session-agent.js";
import { NonRetryableError } from "#shared/run-errors.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";
import type { AgentRoster } from "./roster.js";
import { agentActionInput } from "./target.js";

/**
 * Whether `name` is the `agent` tool's copy of `owner` (a subagent can take the name). Only a
 * root session can start the copy, so only a root session's delegates list it.
 */
const isCopy = (owner: CodeAgent, name: string) =>
  name === AGENT_TOOL_NAME && !owner.subagents.has(name);

/** The agents a session of `owner` delegates to, by name, as a workflow tool's `ctx.agents`. */
export function codeAgentDelegates(
  owner: CodeAgent,
  isRootSession: boolean,
): Readonly<Record<string, WorkflowAgentMetadata>> {
  return {
    ...(isRootSession &&
      isCopy(owner, AGENT_TOOL_NAME) && {
        [AGENT_TOOL_NAME]: { description: owner.description ?? "" },
      }),
    ...Object.fromEntries(
      [...owner.subagents.values()].map(({ description, name }) => [name, { description }]),
    ),
  };
}

/**
 * The roster of an agent defined in code: the subagents it declares, each its own held agent,
 * and the `agent` tool's copy of itself, which only a root session can start. Its children run
 * where it does, so it has no remote agents.
 */
export function codeAgentRoster(owner: CodeAgent): AgentRoster {
  return {
    childRuntime: (target) => ({
      agent: target.source.type === "runtime" ? owner : declared(owner, target.action.name).agent,
    }),
    resolveAction(callId, input) {
      const name = input.target;
      const common = { callId, input: agentActionInput(input), name, subagentName: name };
      if (isCopy(owner, name)) {
        return {
          ...common,
          description: AGENT_TOOL_DESCRIPTION,
          kind: "subagent-call",
          nodeId: runtimeNodeId(owner),
        };
      }
      const { agent, description } = declared(owner, name);
      return { ...common, description, kind: "subagent-call", nodeId: runtimeNodeId(agent) };
    },
    runtimeOverrides: async (name) => {
      throw new NonRetryableError(
        `ctx.agent("${name}", { model }) can't override the model of an agent defined in code yet.`,
      );
    },
    startTarget(action, isRootSession) {
      if (action.kind !== "subagent-call") {
        throw new NonRetryableError(`Agent "${owner.id}" has no remote agent "${action.name}".`);
      }
      if (isCopy(owner, action.subagentName)) {
        if (!isRootSession) {
          throw new NonRetryableError(
            'The built-in "agent" tool is only available to the root session.',
          );
        }
        return { action, kind: "local", source: { type: "runtime" } };
      }
      const { description } = declared(owner, action.subagentName);
      return { action, kind: "local", source: { description, type: "local" } };
    },
  };
}

function declared(owner: CodeAgent, name: string) {
  const subagent = owner.subagents.get(name);
  if (subagent === undefined) {
    throw new NonRetryableError(`Agent target "${name}" is not available to this agent.`);
  }
  return subagent;
}
