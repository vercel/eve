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

// How a run's `ctx.agent` resolves and prepares the session it opens, on any host. Workflow opens
// it in a step (`steps.ts`); the in-process host opens it in its process. Both go through
// `agentSessionsOver` (`sessions-over.ts`), which chooses between a local and a remote session.

/** Where a session a run opened lives, for its later sends, cancels, and end. */
export type AgentSessionAddress =
  | {
      readonly kind: "local";
      readonly name: string;
      readonly nodeId: string;
      readonly sessionId: string;
      /** Names the session to whichever run holds its inbox. */
      readonly continuationToken: string;
    }
  | {
      readonly callbackBaseUrl: string;
      readonly kind: "remote";
      readonly forwardPrincipal?: boolean;
      readonly name: string;
      readonly nodeId: string;
      /** Keys the authored credential functions, as on `child.opened`. */
      readonly resolverId?: string;
      /**
       * A dynamic remote agent's binding, which its credentials are built from again: the child
       * keeps the session it was opened with, whatever the parent's session becomes. Private.
       */
      readonly dynamicBinding?: DynamicRemoteBinding;
      readonly sessionId: string;
      readonly url: string;
      /** The child's remote agent protocol, when it speaks an earlier one than this deployment. */
      readonly earlierProtocol?: number;
    };

/** A session a run opened, with the context of the call that opened it: its lineage. */
export interface OpenedAgentSession {
  readonly address: AgentSessionAddress;
  readonly context: AgentSessionContext;
  /** Names the session within its run, as when it opened. */
  readonly key: string;
}

/**
 * A message a session accepted. An earlier-protocol remote agent names no delivery, so
 * nothing records it.
 */
export interface AgentSessionReceipt {
  readonly sessionId: string;
  readonly deliveryId?: string;
}

/**
 * One message to a session, as the call that sends it: the session runs the
 * message with that call's auth. Its turn's result and questions arrive on
 * `replyTo`.
 */
export interface AgentSessionMessage {
  readonly auth: SessionAuth;
  readonly message: MessageContent<string | URL>;
  readonly outputSchema?: JsonObject;
  readonly replyTo: string;
}

/** What a run's `ctx.agent(name)` opens a session with: its first message, and who opens it. */
export type AgentSessionOpenInput = AgentSessionMessage & {
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly model?: AgentSessionModelSelection;
  readonly name: string;
  /** The workflow tool whose run opens the session. */
  readonly toolName?: string;
};

/** A session a run started, as the run addresses it. */
export interface StartedAgentSession {
  readonly address: AgentSessionAddress;
  /** The opening message's delivery; an earlier-protocol remote agent names none. */
  readonly deliveryId?: string;
}

export type LocalAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "local" }>;
};

export type RemoteAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "remote" }>;
};

/** The command that sends a later message to a local session, as the call that sends it. */
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

/** Why a run's sessions end with it. */
export const AGENT_SESSION_RUN_FINISHED_REASON =
  "The workflow run that opened this session finished.";

/** The command that ends a session its run is done with, delivered as `deliveryId`. */
export function agentSessionResetCommand(deliveryId: string) {
  return {
    kind: "reset",
    reason: AGENT_SESSION_RUN_FINISHED_REASON,
    deliveryId,
  } as const satisfies SessionCommand;
}

export interface SessionStart<Target extends SubagentStartTarget> {
  readonly auth: SessionAuth;
  /** The agents the call's session delegates to, which resolved the target. */
  readonly roster: AgentRoster;
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly replyTo: string;
  readonly runtimeOverrides?: AgentSessionRuntimeOverrides;
  readonly target: Target;
}

export type LocalStartTarget = Extract<SubagentStartTarget, { readonly kind: "local" }>;
export type RemoteStartTarget = Extract<SubagentStartTarget, { readonly kind: "remote" }>;

/** A local child session, ready to start on whichever host runs its parent's run. */
export interface PreparedLocalAgentSession {
  /** Starts the child, its first message delivered as `deliveryId`. */
  readonly runInput: RunInput;
  /** What the child's runtime runs: its agent, and any overrides. */
  readonly runtime: SessionRuntimeConfig;
  /** The child's address, once a session id is known. */
  readonly address: (sessionId: string) => Extract<AgentSessionAddress, { readonly kind: "local" }>;
  readonly childContinuationToken: string;
  readonly deliveryId: string;
}

/**
 * Builds the local session a run's `ctx.agent` starts, without starting it: Workflow starts it as
 * a durable run, and the in-process host in its process.
 */
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

/**
 * Resolves what a run's `ctx.agent(name)` opens: the agent, its target, and any model override.
 * Host-free; the host starts the session it resolves.
 */
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
