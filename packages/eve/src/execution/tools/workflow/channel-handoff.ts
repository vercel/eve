import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { sendToChannelStep } from "#execution/tools/workflow/channel-handoff-steps.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { WorkflowChannelSendOptions } from "#tools/workflow-definition.js";

/** `ctx.sendToChannel()` for a workflow body: one step against the root agent's channels. */
export async function sendToChannel(
  context: AgentSessionContext,
  channel: string,
  message: string,
  options: WorkflowChannelSendOptions<unknown>,
): Promise<{ readonly sessionId: string }> {
  const { nodeId } = context.bundle;
  // A channel session runs the root agent with all its tools, so a subagent's
  // tool must not start one.
  if (nodeId !== undefined && nodeId !== ROOT_RUNTIME_AGENT_NODE_ID) {
    throw new Error(
      "ctx.sendToChannel() is only available to workflow tools on the root agent. Channels " +
        "belong to the root agent, and a subagent's tools cannot start sessions on them.",
    );
  }
  if (typeof channel !== "string" || channel.trim() === "") {
    throw new TypeError(
      'ctx.sendToChannel() requires the channel\'s path-derived name, such as "slack".',
    );
  }
  return await sendToChannelStep({
    auth: options.auth,
    bundle: context.bundle,
    callerSessionId: context.parent.sessionId,
    channel,
    history: options.history,
    localDevRequest: context.localDevRequest,
    message,
    target: options.target as Readonly<Record<string, unknown>>,
    turnPolicy: options.turnPolicy,
  });
}
