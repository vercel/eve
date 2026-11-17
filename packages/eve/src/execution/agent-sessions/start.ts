import type { MessageContent } from "#shared/message-content.js";
import { NonRetryableError } from "#shared/run-errors.js";
import type { RunInput, SessionCommand } from "#channel/types.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import { loadAgentRoster, type AgentRoster } from "#execution/agent-sessions/roster.js";
import type { SubagentStartTarget } from "#execution/agent-sessions/target.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { AgentSessionModelSelection } from "#tools/workflow-definition.js";
import type { JsonObject } from "#shared/json.js";
import type { SubagentParentContext } from "#subagents/invocation.js";
import type { DynamicRemoteBinding } from "#definitions/remote.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { stubToolPath } from "#tool-stubs/target.js";

export type AgentSessionAddress =
  | {
      readonly kind: "local";
      readonly name: string;
      readonly nodeId: string;
      readonly sessionId: string;
      readonly continuationToken: string;
    }
  | {
      readonly callbackBaseUrl: string;
      readonly kind: "remote";
      readonly forwardPrincipal?: boolean;
      readonly name: string;
      readonly nodeId: string;
      readonly resolverId?: string;
      readonly dynamicBinding?: DynamicRemoteBinding;
      readonly sessionId: string;
      readonly url: string;
      readonly earlierProtocol?: number;
    };

export interface OpenedAgentSession {
  readonly address: AgentSessionAddress;
  readonly context: AgentSessionContext;
  readonly key: string;
}

export interface AgentSessionReceipt {
  readonly sessionId: string;
  readonly deliveryId?: string;
}

export interface AgentSessionMessage {
  readonly auth: SessionAuth;
  readonly message: MessageContent<string | URL>;
  readonly outputSchema?: JsonObject;
  readonly replyTo: string;
}

export type AgentSessionOpenInput = AgentSessionMessage & {
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly model?: AgentSessionModelSelection;
  readonly name: string;
  readonly toolName?: string;
};

export interface StartedAgentSession {
  readonly address: AgentSessionAddress;
  readonly deliveryId?: string;
}

export type LocalAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "local" }>;
};

export type RemoteAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "remote" }>;
};

export function localAgentSendCommand(
  input: AgentSessionMessage & LocalAgentSession,
  deliveryId: string,
) {
  const { address, context } = input;
  return {
    auth: input.auth.current,
    schedule: context.schedule,
    caller: {
      callId: context.parent.callId,
      replyTo: { kind: "hook", token: input.replyTo },
      subagentName: address.name,
    },
    kind: "send",
    delivery: { channelKind: "subagent", channelName: "subagent", deliveryId },
    payload: { message: input.message, outputSchema: input.outputSchema },
  } as const satisfies SessionCommand;
}

export const AGENT_SESSION_RUN_FINISHED_REASON =
  "The workflow run that opened this session finished.";

export function agentSessionResetCommand(deliveryId: string) {
  return {
    kind: "reset",
    reason: AGENT_SESSION_RUN_FINISHED_REASON,
    deliveryId,
  } as const satisfies SessionCommand;
}

export interface SessionStart<Target extends SubagentStartTarget> {
  readonly auth: SessionAuth;
  readonly roster: AgentRoster;
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly replyTo: string;
  readonly runtimeOverrides?: AgentSessionRuntimeOverrides;
  readonly target: Target;
}

export type LocalStartTarget = Extract<SubagentStartTarget, { readonly kind: "local" }>;
export type RemoteStartTarget = Extract<SubagentStartTarget, { readonly kind: "remote" }>;

export interface PreparedLocalAgentSession {
  readonly runInput: RunInput;
  readonly runtime: SessionRuntimeConfig;
  readonly address: (sessionId: string) => Extract<AgentSessionAddress, { readonly kind: "local" }>;
  readonly childContinuationToken: string;
  readonly deliveryId: string;
}

export function prepareLocalAgentSession(
  input: SessionStart<LocalStartTarget>,
): PreparedLocalAgentSession {
  const { auth, context, roster, target } = input;
  const { action } = target;
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: auth.current,
    capabilities: context.capabilities,
    schedule: context.schedule,
    channelMetadata: context.channelMetadata,
    continuationKey: input.key,
    graph: roster.graph,
    inheritedConversation: context.conversation,
    initiatorAuth: auth.initiator,
    parent: createParentContext(context, input.replyTo),
    sandboxSessionId: context.sandbox.sessionId,
    selfAgent: target.source.type === "runtime",
    session: {
      continuationToken: input.replyTo,
      sandboxState: context.sandbox.state,
      sessionId: context.parent.sessionId,
    },
    source: target.source,
  });
  let childToolStubs = context.toolStubs;
  if (childToolStubs !== undefined) {
    childToolStubs = {
      ...childToolStubs,
      agentPath: stubToolPath(childToolStubs, action.name),
    };
  }
  const deliveryId = `agent-session:${input.key}:initial`;
  return {
    address: (sessionId) => ({
      continuationToken: childContinuationToken,
      kind: "local",
      name: action.name,
      nodeId: action.nodeId,
      sessionId,
    }),
    childContinuationToken,
    deliveryId,
    runInput: {
      ...runInput,
      delivery: { channelKind: "subagent", channelName: "subagent", deliveryId },
      toolStubs: childToolStubs,
    },
    runtime: roster.childRuntime(target, input.runtimeOverrides),
  };
}

export async function resolveAgentSessionStart(
  input: AgentSessionOpenInput,
): Promise<SessionStart<SubagentStartTarget> & { readonly agentName: string }> {
  const { context } = input;
  const roster = await loadAgentRoster(context);
  const action = roster.resolveAction(context.parent.callId, {
    message: input.message,
    outputSchema: input.outputSchema,
    target: input.name,
  });
  const target = roster.startTarget(
    action,
    context.parent.rootSessionId === context.parent.sessionId,
  );
  if (input.model !== undefined && target.kind === "remote") {
    throw new NonRetryableError(
      `ctx.agent("${input.name}", { model }) cannot override a remote agent's model. Configure the model on the receiving agent.`,
    );
  }
  const runtimeOverrides =
    input.model === undefined
      ? undefined
      : await roster.runtimeOverrides(input.name, input.model, input.toolName);
  return {
    agentName: action.name,
    auth: input.auth,
    context,
    key: input.key,
    replyTo: input.replyTo,
    roster,
    runtimeOverrides,
    target,
  };
}

export function createParentContext(
  context: AgentSessionContext,
  replyTo: string,
): SubagentParentContext {
  return {
    continuationToken: replyTo,
    conversationId:
      context.trace.conversationId ?? resolveConversationId(context.parent.rootSessionId),
    lineage: context.parent,
    originAudience: context.trace.originAudience,
    traceContext: context.trace.parentTraceContext,
    traceRoot: context.traceRoot,
  };
}
