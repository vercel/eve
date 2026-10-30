import type { MessageContent } from "#shared/message-content.js";
import {
  FatalError,
  getStepMetadata,
  getWorkflowMetadata,
} from "#compiled/@workflow/core/index.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import {
  resolveAgentAction,
  resolveAgentStartTarget,
  type SubagentStartTarget,
} from "#execution/agent-sessions/target.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeHook } from "#internal/workflow/runtime.js";
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
import {
  InvalidRuntimeModelSelectionError,
  resolveRuntimeModelSelection,
} from "#runtime/agent/resolve-model.js";
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
} from "#execution/agent-sessions/remote.js";
import { remoteAgentCredentials } from "#execution/agent-sessions/remote-credentials.js";
import type { DynamicRemoteBinding } from "#reactions/remote.js";
import type { RemoteAgentCredentials } from "#runtime/subagents/dynamic-remote-agent-config.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { stubToolPath } from "#tool-stubs/target.js";
import { agentDelegation } from "#tracing/eve/delegation.js";
import type { AgentSessionModelSelection } from "#tools/workflow-definition.js";

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

type RemoteAgentSessionAddress = Extract<AgentSessionAddress, { readonly kind: "remote" }>;

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

/**
 * Opens a run's session with its first message, as a child of the call whose
 * `context` it binds. `key` names the handle within the run, so a retried step
 * reaches the same session instead of a second one.
 */
export async function openAgentSessionStep(
  input: AgentSessionMessage & {
    readonly context: AgentSessionContext;
    readonly key: string;
    readonly model?: AgentSessionModelSelection;
    readonly name: string;
  },
): Promise<{ readonly address: AgentSessionAddress; readonly deliveryId?: string }> {
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
  if (input.model !== undefined && target.kind === "remote") {
    throw new FatalError(
      `ctx.agent("${input.name}", { model }) cannot override a remote agent's model. Configure the model on the receiving agent.`,
    );
  }
  const runtimeOverrides =
    input.model === undefined
      ? undefined
      : await normalizeRuntimeOverrides({ bundle, model: input.model, name: input.name });
  const start = {
    auth: input.auth,
    bundle,
    context,
    key: input.key,
    replyTo: input.replyTo,
    runtimeOverrides,
  };
  const execute = () =>
    target.kind === "remote"
      ? startRemoteSession({ ...start, target })
      : startLocalSession({ ...start, target });
  return await agentDelegation.resume({ context, agentName: action.name }, execute);
}

async function normalizeRuntimeOverrides({
  bundle,
  model,
  name,
}: {
  readonly bundle: CompiledBundle;
  readonly model: AgentSessionModelSelection;
  readonly name: string;
}): Promise<AgentSessionRuntimeOverrides> {
  try {
    const selection = await resolveRuntimeModelSelection({
      durability: "durable",
      modelMetadata: bundle.modelMetadata,
      selection: model,
    });
    return { model: selection.reference };
  } catch (error) {
    if (error instanceof InvalidRuntimeModelSelectionError) {
      throw new FatalError(
        `ctx.agent("${name}", { model }) could not resolve the model selection: ${toErrorMessage(error)}`,
      );
    }
    throw error;
  }
}

/**
 * Sends a later message; it joins the session's running turn or starts the
 * next. It keeps the session's lineage and carries its own auth.
 */
export async function sendAgentSessionMessageStep(
  input: AgentSessionMessage & OpenedAgentSession,
): Promise<AgentSessionReceipt> {
  "use step";

  const { address, context } = input;
  if (address.kind === "remote") {
    const remote = await resolveSessionRemote(context, address);
    return await continueRemoteAgentSession({
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
      earlierProtocol: address.earlierProtocol,
      // The step's own identity, so its retry repeats the same delivery, as a local child's does.
      idempotencyKey: agentDeliveryId("send", address.sessionId),
      message: input.message,
      outputSchema: input.outputSchema,
      remote,
      sessionId: address.sessionId,
    });
  }
  const deliveryId = agentDeliveryId("send", address.sessionId);
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
      delivery: { channelKind: "subagent", channelName: "subagent", deliveryId },
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
  return { deliveryId, sessionId: result.sessionId };
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
    await commandLocalSession(
      { ...input, address },
      { kind: "cancel", deliveryId: agentDeliveryId("cancel", address.sessionId) },
    );
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

/** Best-effort cleanup for a late address whose cancelled run cannot own it. */
export async function stopLateAgentSessionStep(opened: OpenedAgentSession): Promise<void> {
  "use step";
  if (opened.address.kind === "remote") {
    await endAgentSession(opened);
    return;
  }
  const { sessionId } = opened.address;
  try {
    // Waiting for a booting inbox would hold the parent's next turn.
    await resumeHook(sessionInboxHookToken(sessionCommandHookToken(sessionId)), {
      kind: "reset",
      reason: RUN_FINISHED_REASON,
      deliveryId: agentDeliveryId("reset", sessionId),
    });
  } catch (error) {
    logError(log, "could not stop late child; cleanup is best effort", error, { sessionId });
  }
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
      {
        kind: "reset",
        reason: RUN_FINISHED_REASON,
        deliveryId: agentDeliveryId("reset", address.sessionId),
      },
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
  readonly runtimeOverrides?: AgentSessionRuntimeOverrides;
  readonly target: Target;
}

async function startLocalSession(
  input: SessionStart<Extract<SubagentStartTarget, { readonly kind: "local" }>>,
): Promise<{ readonly address: AgentSessionAddress; readonly deliveryId: string }> {
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
    agentSessionRuntimeOverrides: input.runtimeOverrides,
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
  const deliveryId = `agent-session:${input.key}:initial`;
  const started = await contextStorage.run(
    new ContextContainer({ localDevRequest: context.localDevRequest }),
    () =>
      childRuntime.createSession({
        ...runInput,
        delivery: { channelKind: "subagent", channelName: "subagent", deliveryId },
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
    address: {
      continuationToken: childContinuationToken,
      kind: "local",
      name: action.name,
      nodeId: action.nodeId,
      sessionId,
    },
    deliveryId,
  };
}

async function startRemoteSession(
  input: SessionStart<Extract<SubagentStartTarget, { readonly kind: "remote" }>>,
): Promise<{ readonly address: AgentSessionAddress; readonly deliveryId?: string }> {
  const { auth, bundle, context, target } = input;
  const { action } = target;
  const dynamicBinding = bindingFor(context, action.nodeId);
  const remote = resolveRemoteAgentForAction({
    credentials:
      target.dynamicRemoteAgent === undefined
        ? undefined
        : await credentialsOf(bundle, action.nodeId, dynamicBinding, {
            name: action.remoteAgentName,
            url: target.dynamicRemoteAgent.url,
          }),
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
  const address: {
    -readonly [K in keyof RemoteAgentSessionAddress]: RemoteAgentSessionAddress[K];
  } = {
    callbackBaseUrl,
    kind: "remote",
    forwardPrincipal: remote.forwardPrincipal,
    name: action.remoteAgentName,
    nodeId: action.nodeId,
    resolverId: action.nodeId,
    sessionId: child.sessionId,
    url: remote.url,
  };
  if (dynamicBinding !== undefined) address.dynamicBinding = dynamicBinding;
  if (child.earlierProtocol !== undefined) address.earlierProtocol = child.earlierProtocol;
  return child.deliveryId === undefined ? { address } : { address, deliveryId: child.deliveryId };
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
    // Credentials come from the binding the child was opened with, and go only to its destination.
    credentials: await credentialsOf(bundle, address.nodeId, address.dynamicBinding, address),
    dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
    nodeId: address.nodeId,
    registry: bundle.subagentRegistry.subagentsByNodeId,
    remoteAgentName: address.name,
  });
  return { ...resolved, url: address.url };
}

/** The binding a dynamic remote agent with credentials keeps for a child opened now. */
function bindingFor(
  context: AgentSessionContext,
  nodeId: string,
): DynamicRemoteBinding | undefined {
  const selection = context.dynamicSelections[nodeId];
  return selection?.kind === "remote" && selection.remoteAgent.credentials === true
    ? selection.binding
    : undefined;
}

/**
 * A dynamic remote agent's credentials, built from `binding` for `destination`. `undefined` for
 * one without credentials, which keeps no binding.
 */
async function credentialsOf(
  bundle: CompiledBundle,
  nodeId: string,
  binding: DynamicRemoteBinding | undefined,
  destination: { readonly name: string; readonly url: string },
): Promise<RemoteAgentCredentials | undefined> {
  if (binding === undefined) return undefined;
  return await remoteAgentCredentials({
    binding,
    destination,
    nodeId,
    resolvers: bundle.subagentRegistry.dynamicResolvers,
  });
}

async function loadAgentSessionBundle(context: AgentSessionContext): Promise<CompiledBundle> {
  return await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(context.bundle.source),
    nodeId: context.bundle.nodeId,
  });
}

function agentDeliveryId(kind: string, sessionId: string): string {
  return `agent-session:${getWorkflowMetadata().workflowRunId}:${getStepMetadata().stepId}:${sessionId}:${kind}`;
}
