import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import {
  resolveAgentAction,
  resolveAgentStartTarget,
  type SubagentStartTarget,
} from "#execution/agent-sessions/target.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  createWorkflowCallbackUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  dispatchWorkflowSessionCommand,
  waitForCommandHookOwner,
  resolveContinuation,
  waitForSessionInbox,
} from "#execution/workflow-runtime.js";
import type { SessionCommand, SessionCommandResult } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import type { SubagentParentContext } from "#subagents/invocation.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  resetRemoteAgentSession,
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { stubToolPath } from "#tool-stubs/target.js";
import { agentDelegation } from "#tracing/eve/delegation.js";

const log = createLogger("execution.agent-sessions");

const RUN_FINISHED_REASON = "The workflow run that opened this session finished.";

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
      /** Keys the authored credential functions, as on `agent.started`. */
      readonly resolverId?: string;
      readonly sessionId: string;
      readonly url: string;
    };

/** A session a run opened, with the context of the call that opened it: its lineage. */
export interface OpenedAgentSession {
  readonly address: AgentSessionAddress;
  readonly context: AgentSessionContext;
  /** Names the session within its run, as when it opened. */
  readonly key: string;
}

/**
 * One message to a session, as the call that sends it: the session runs the
 * message with that call's auth. Its turn's result and questions arrive on
 * `replyTo`.
 */
export interface AgentSessionMessage {
  readonly auth: SessionAuth;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly replyTo: string;
}

/**
 * Opens a run's session with its first message, as a child of the call whose
 * `context` it binds. `key` names the handle within the run, so a retried step
 * reaches the same session instead of a second one.
 */
export async function openAgentSessionStep(
  input: AgentSessionMessage & {
    readonly context: AgentSessionContext;
    readonly key: string;
    readonly name: string;
  },
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
  const target = resolveAgentStartTarget({
    action,
    bundle,
    dynamicSelections: context.dynamicSelections,
    isRootSession: context.parent.rootSessionId === context.parent.sessionId,
  });
  const start = { auth: input.auth, bundle, context, key: input.key, replyTo: input.replyTo };
  const execute = () =>
    target.kind === "remote"
      ? startRemoteSession({ ...start, target })
      : startLocalSession({ ...start, target });
  return await agentDelegation.resume({ context, agentName: action.name }, execute);
}

/**
 * Sends a later message; it joins the session's running turn or starts the
 * next. It keeps the session's lineage and carries its own auth.
 */
export async function sendAgentSessionMessageStep(
  input: AgentSessionMessage & OpenedAgentSession,
): Promise<void> {
  "use step";

  const { address, context } = input;
  if (address.kind === "remote") {
    const remote = await resolveSessionRemote(context, address);
    await continueRemoteAgentSession({
      auth: input.auth.current,
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
  const result = await commandLocalSession(
    { ...input, address },
    {
      auth: input.auth.current,
      schedule: context.schedule,
      caller: {
        callId: context.parent.callId,
        replyTo: { kind: "hook", token: input.replyTo },
        subagentName: address.name,
      },
      kind: "send",
      payload: { message: input.message, outputSchema: input.outputSchema },
    },
  ).catch((error: unknown) => {
    if (!SessionStrandedError.is(error)) throw error;
    throw new Error(`Agent "${address.name}" can no longer receive messages: ${error.message}`, {
      cause: error,
    });
  });
  if (result.status !== "accepted") {
    throw new Error(`Agent "${address.name}" can no longer receive messages; its session ended.`);
  }
}

/** Cancels a session's running turn; the turn still reports, as cancelled. */
export async function cancelAgentSessionTurnStep(input: OpenedAgentSession): Promise<void> {
  "use step";

  const { address } = input;
  try {
    if (address.kind === "remote") {
      const remote = await resolveSessionRemote(input.context, address);
      await cancelRemoteAgentTurn({ remote, sessionId: address.sessionId });
      return;
    }
    await commandLocalSession({ ...input, address }, { kind: "cancel" });
  } catch (error) {
    logError(log, "failed to cancel an agent session turn", error, {
      name: address.name,
      sessionId: address.sessionId,
    });
  }
}

/** Ends a run's sessions when the run finishes, cancelling any turn still running. */
export async function endAgentSessionsStep(input: {
  readonly sessions: readonly OpenedAgentSession[];
}): Promise<void> {
  "use step";

  await Promise.all(input.sessions.map(endAgentSession));
}

async function endAgentSession(opened: OpenedAgentSession): Promise<void> {
  const { address, context } = opened;
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
    await commandLocalSession(
      { ...opened, address },
      { kind: "reset", reason: RUN_FINISHED_REASON },
    );
  } catch (error) {
    logError(log, "failed to end an agent session", error, {
      name: address.name,
      sessionId: address.sessionId,
    });
  }
}

type LocalAgentSession = OpenedAgentSession & {
  readonly address: Extract<AgentSessionAddress, { readonly kind: "local" }>;
};

/**
 * Sends a command to a local session. A session opens without waiting for its
 * run to claim its inbox, so a command it refuses before then waits for it.
 * A duplicate start of the session can claim it instead of the run the open
 * recorded, and the command then goes to the session holding its continuation.
 */
async function commandLocalSession<TCommand extends SessionCommand>(
  opened: LocalAgentSession,
  command: TCommand,
): Promise<SessionCommandResult<TCommand>> {
  const { continuationToken, sessionId } = opened.address;
  const result = await dispatchWorkflowSessionCommand({ command, sessionId });
  if (result.status === "accepted" || result.status === "reset") return result;
  const current = (await waitForSessionInbox(sessionId))
    ? sessionId
    : (await resolveContinuation(continuationToken))?.sessionId;
  if (current === undefined) return result;
  return await dispatchWorkflowSessionCommand({ command, sessionId: current });
}

interface SessionStart<Target extends SubagentStartTarget> {
  readonly auth: SessionAuth;
  readonly bundle: CompiledBundle;
  readonly context: AgentSessionContext;
  readonly key: string;
  readonly replyTo: string;
  readonly target: Target;
}

async function startLocalSession(
  input: SessionStart<Extract<SubagentStartTarget, { readonly kind: "local" }>>,
): Promise<AgentSessionAddress> {
  const { auth, bundle, context, target } = input;
  const { action } = target;
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: auth.current,
    capabilities: context.capabilities,
    schedule: context.schedule,
    channelMetadata: context.channelMetadata,
    continuationKey: input.key,
    graph: bundle.graph,
    inheritedConversation: context.conversation,
    initiatorAuth: auth.initiator,
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
  let childToolStubs = context.toolStubs;
  if (childToolStubs !== undefined) {
    childToolStubs = {
      ...childToolStubs,
      agentPath: stubToolPath(childToolStubs, action.name),
    };
  }
  const started = await contextStorage.run(
    new ContextContainer({ localDevRequest: context.localDevRequest }),
    () =>
      childRuntime.createSession({
        ...runInput,
        toolStubs: childToolStubs,
      }),
  );
  // Waiting for the run to claim the session would hold the caller for the
  // child's boot. A retried attempt may have started a second run, so it waits
  // to learn which run claimed the session; later commands resolve it again.
  let sessionId = started.sessionId;
  if (getStepMetadata().attempt > 1) {
    ({ runId: sessionId } = await waitForCommandHookOwner(
      sessionInboxHookToken(childContinuationToken),
    ));
  }
  return {
    continuationToken: childContinuationToken,
    kind: "local",
    name: action.name,
    nodeId: action.nodeId,
    sessionId,
  };
}

async function startRemoteSession(
  input: SessionStart<Extract<SubagentStartTarget, { readonly kind: "remote" }>>,
): Promise<AgentSessionAddress> {
  const { auth, bundle, context, target } = input;
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
    auth: auth.current,
    callbackBaseUrl,
    capabilities: context.capabilities,
    initiatorAuth: auth.initiator,
    operationId: `agent-session:${input.key}`,
    originAudience: context.trace.originAudience,
    parent: createParentContext(context, input.replyTo),
    remote,
    session: { continuationToken: input.replyTo },
  });
  return {
    callbackBaseUrl,
    kind: "remote",
    forwardPrincipal: remote.forwardPrincipal,
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
    traceRoot: context.traceRoot,
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
