import { FatalError, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { resolveAgentAction, resolveAgentStartTarget } from "#execution/agent-sessions/target.js";
import { deriveChildActivityObserverConfig } from "#execution/activity-work.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { SubagentStartTarget } from "#execution/tools/subagent/start.js";
import {
  createWorkflowCallbackUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  dispatchWorkflowSessionCommand,
  requestWorkflowTurnCancellation,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import type { SubagentParentContext } from "#subagents/invocation.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  resetRemoteAgentSession,
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#subagents/remote-dispatch.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { resolveConversationId } from "#shared/conversation-identity.js";

const log = createLogger("execution.agent-sessions");

const RUN_FINISHED_REASON = "The workflow run that opened this session finished.";

/** Where a session a run opened lives, for its later sends, cancels, and end. */
export type AgentSessionAddress =
  | {
      readonly kind: "local";
      readonly name: string;
      readonly nodeId: string;
      readonly sessionId: string;
    }
  | {
      readonly callbackBaseUrl: string;
      readonly kind: "remote";
      readonly name: string;
      readonly nodeId: string;
      /** Keys the authored credential functions, as on `agent.started`. */
      readonly resolverId?: string;
      readonly sessionId: string;
      readonly url: string;
    };

/** One message to a session; its turn's result and questions arrive on `replyTo`. */
export interface AgentSessionMessage {
  readonly context: AgentSessionContext;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly replyTo: string;
}

/**
 * Opens a run's session with its first message. `key` names the handle within
 * the run, so a retried step reaches the same session instead of a second one.
 */
export async function openAgentSessionStep(
  input: AgentSessionMessage & { readonly key: string; readonly name: string },
): Promise<AgentSessionAddress> {
  "use step";

  const { context } = input;
  const bundle = await loadAgentSessionBundle(context);
  const action = resolveAgentAction({
    bundle,
    callId: context.parent.callId,
    dynamicSelections: context.dynamicSelections,
    input: { message: input.message, outputSchema: input.outputSchema, target: input.name },
  });
  const plan = resolveAgentStartTarget({
    action,
    bundle,
    dynamicSelections: context.dynamicSelections,
    isRootSession: context.parent.rootSessionId === context.parent.sessionId,
  });
  if (plan.kind === "reject") {
    throw new FatalError(toErrorMessage(plan.result.output));
  }
  const start = { bundle, context, key: input.key, replyTo: input.replyTo };
  if (plan.target.kind === "remote") {
    return await startRemoteSession({ ...start, target: plan.target });
  }
  return await startLocalSession({ ...start, target: plan.target });
}

/** Sends a later message; it joins the session's running turn or starts the next. */
export async function sendAgentSessionMessageStep(
  input: AgentSessionMessage & { readonly address: AgentSessionAddress },
): Promise<void> {
  "use step";

  const { address, context } = input;
  if (address.kind === "remote") {
    const remote = await resolveSessionRemote(context, address);
    await continueRemoteAgentSession({
      activityObserver: context.activityObserver,
      auth: context.auth,
      callback: {
        callId: context.parent.callId,
        subagentName: address.name,
        token: input.replyTo,
        url: createWorkflowCallbackUrl(
          address.callbackBaseUrl,
          createEveCallbackRoutePath(input.replyTo),
        ),
      },
      message: input.message,
      outputSchema: input.outputSchema,
      remote,
      sessionId: address.sessionId,
    });
    return;
  }
  const result = await dispatchWorkflowSessionCommand({
    command: {
      auth: context.auth,
      caller: {
        activityObserver: context.activityObserver,
        callId: context.parent.callId,
        replyTo: { kind: "hook", token: input.replyTo },
        subagentName: address.name,
      },
      kind: "send",
      payload: { message: input.message, outputSchema: input.outputSchema },
    },
    sessionId: address.sessionId,
  });
  if (result.status !== "accepted") {
    throw new Error(`Agent "${address.name}" can no longer receive messages; its session ended.`);
  }
}

/** Cancels a session's running turn; the turn still reports, as cancelled. */
export async function cancelAgentSessionTurnStep(input: {
  readonly address: AgentSessionAddress;
  readonly context: AgentSessionContext;
}): Promise<void> {
  "use step";

  const { address } = input;
  try {
    if (address.kind === "remote") {
      const remote = await resolveSessionRemote(input.context, address);
      await cancelRemoteAgentTurn({ remote, sessionId: address.sessionId });
      return;
    }
    await requestWorkflowTurnCancellation({ sessionId: address.sessionId });
  } catch (error) {
    logError(log, "failed to cancel an agent session turn", error, {
      name: address.name,
      sessionId: address.sessionId,
    });
  }
}

/** Ends a run's sessions when the run finishes, cancelling any turn still running. */
export async function endAgentSessionsStep(input: {
  readonly context: AgentSessionContext;
  readonly sessions: readonly AgentSessionAddress[];
}): Promise<void> {
  "use step";

  await Promise.all(input.sessions.map((address) => endAgentSession(input.context, address)));
}

async function endAgentSession(
  context: AgentSessionContext,
  address: AgentSessionAddress,
): Promise<void> {
  try {
    if (address.kind === "remote") {
      const remote = await resolveSessionRemote(context, address);
      await resetRemoteAgentSession({
        reason: RUN_FINISHED_REASON,
        remote,
        sessionId: address.sessionId,
      });
      return;
    }
    await dispatchWorkflowSessionCommand({
      command: { kind: "reset", reason: RUN_FINISHED_REASON },
      sessionId: address.sessionId,
    });
  } catch (error) {
    logError(log, "failed to end an agent session", error, {
      name: address.name,
      sessionId: address.sessionId,
    });
  }
}

interface SessionStart<Target extends SubagentStartTarget> {
  readonly bundle: CompiledBundle;
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly replyTo: string;
  readonly target: Target;
}

async function startLocalSession(
  input: SessionStart<Extract<SubagentStartTarget, { readonly kind: "local" }>>,
): Promise<AgentSessionAddress> {
  const { bundle, context, target } = input;
  const { action } = target;
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    activityObserver: context.activityObserver,
    auth: context.auth,
    capabilities: context.capabilities,
    channelMetadata: context.channelMetadata,
    continuationKey: input.key,
    graph: bundle.graph,
    inheritedConversation: context.conversation,
    initiatorAuth: context.initiatorAuth,
    limits: context.limits,
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
  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig: target.dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  await contextStorage.run(new ContextContainer({ localDevRequest: context.localDevRequest }), () =>
    childRuntime.createSession(runInput),
  );
  const owner = await waitForCommandHookOwner(sessionInboxHookToken(childContinuationToken));
  return { kind: "local", name: action.name, nodeId: action.nodeId, sessionId: owner.runId };
}

async function startRemoteSession(
  input: SessionStart<Extract<SubagentStartTarget, { readonly kind: "remote" }>>,
): Promise<AgentSessionAddress> {
  const { bundle, context, target } = input;
  const { action } = target;
  const remote = resolveRemoteAgentForAction({
    dynamicRemoteAgent: target.dynamicRemoteAgent,
    nodeId: action.nodeId,
    registry: bundle.subagentRegistry.subagentsByNodeId,
    remoteAgentName: action.remoteAgentName,
  });
  const callbackBaseUrl = resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url);
  const child = await startRemoteAgentSession({
    action,
    activityObserver: deriveChildActivityObserverConfig({
      activityObserver: context.activityObserver,
      callId: action.callId,
      kind: "remote-agent",
      name: action.remoteAgentName,
      parentSessionId: context.parent.sessionId,
      parentTurnId: context.parent.turn.id,
    }),
    auth: context.auth,
    callbackBaseUrl,
    initiatorAuth: context.initiatorAuth,
    operationId: `agent-session:${input.key}`,
    originAudience: context.trace.originAudience,
    parent: createParentContext(context, input.replyTo),
    remote,
    session: { continuationToken: input.replyTo },
  });
  return {
    callbackBaseUrl,
    kind: "remote",
    name: action.remoteAgentName,
    nodeId: action.nodeId,
    resolverId: target.dynamicRemoteAgent?.credentialsStepId ?? action.nodeId,
    sessionId: child.sessionId,
    url: remote.url,
  };
}

function createParentContext(context: AgentSessionContext, replyTo: string): SubagentParentContext {
  return {
    continuationToken: replyTo,
    conversationId:
      context.trace.conversationId ?? resolveConversationId(context.parent.rootSessionId),
    lineage: context.parent,
    originAudience: context.trace.originAudience,
    traceContext: context.trace.parentTraceContext,
  };
}

/** A remote session keeps running where it was opened, even after the registry moves on. */
async function resolveSessionRemote(
  context: AgentSessionContext,
  address: Extract<AgentSessionAddress, { readonly kind: "remote" }>,
): Promise<ResolvedRuntimeRemoteAgentNode> {
  const bundle = await loadAgentSessionBundle(context);
  const selection = context.dynamicSelections[address.nodeId];
  const resolved = resolveRemoteAgentForAction({
    dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
    nodeId: address.nodeId,
    registry: bundle.subagentRegistry.subagentsByNodeId,
    remoteAgentName: address.name,
  });
  return { ...resolved, url: address.url };
}

async function loadAgentSessionBundle(context: AgentSessionContext): Promise<CompiledBundle> {
  return await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(context.bundle.source),
    nodeId: context.bundle.nodeId,
  });
}
