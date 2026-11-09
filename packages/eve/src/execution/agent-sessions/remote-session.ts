import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  resetRemoteAgentSession,
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import { remoteAgentCredentials } from "#execution/agent-sessions/remote-credentials.js";
import {
  AGENT_SESSION_RUN_FINISHED_REASON,
  createParentContext,
  type AgentSessionMessage,
  type AgentSessionReceipt,
  type RemoteAgentSession,
  type RemoteStartTarget,
  type SessionStart,
  type StartedAgentSession,
} from "#execution/agent-sessions/start.js";
import type { DynamicRemoteBinding } from "#definitions/remote.js";
import { NonRetryableError } from "#shared/run-errors.js";
import { loadAgentRoster, type AgentRoster } from "#execution/agent-sessions/roster.js";
import type { RemoteAgentCredentials } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

// A run's sessions on remote agents, over eve's remote agent protocol: plain HTTP, which any host
// that serves eve's callback route can make. `agentSessionsOver` (`sessions-over.ts`) sends here
// for a remote address.

/**
 * Opens a session on a remote agent, which answers at eve's callback route under
 * `callbackBaseUrl`. `operationId` names the open, so a retry reaches the same session.
 */
export async function startRemoteSession(
  input: SessionStart<RemoteStartTarget>,
  access: { readonly callbackBaseUrl: string; readonly operationId: string },
): Promise<StartedAgentSession> {
  const { auth, context, target } = input;
  const { action } = target;
  const registry = remoteRegistryOf(input.roster, action.remoteAgentName);
  const dynamicBinding = bindingFor(context, action.nodeId);
  const remote = resolveRemoteAgentForAction({
    credentials:
      target.dynamicRemoteAgent === undefined
        ? undefined
        : await credentialsOf(registry, action.nodeId, dynamicBinding, {
            name: action.remoteAgentName,
            url: target.dynamicRemoteAgent.url,
          }),
    dynamicRemoteAgent: target.dynamicRemoteAgent,
    nodeId: action.nodeId,
    registry: registry.subagentsByNodeId,
    remoteAgentName: action.remoteAgentName,
  });
  const { callbackBaseUrl } = access;
  const child = await startRemoteAgentSession({
    action,
    auth: auth.current,
    callbackBaseUrl,
    capabilities: context.capabilities,
    initiatorAuth: auth.initiator,
    operationId: access.operationId,
    originAudience: context.trace.originAudience,
    parent: createParentContext(context, input.replyTo),
    remote,
    session: { continuationToken: input.replyTo },
  });
  const address: {
    -readonly [K in keyof RemoteAgentSession["address"]]: RemoteAgentSession["address"][K];
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

/** Sends a later message to a remote session; `idempotencyKey` makes a retry repeat it. */
export async function sendRemoteSessionMessage(
  input: AgentSessionMessage & RemoteAgentSession,
  idempotencyKey: string,
): Promise<AgentSessionReceipt> {
  const { address, context } = input;
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
    idempotencyKey,
    message: input.message,
    outputSchema: input.outputSchema,
    remote,
    sessionId: address.sessionId,
  });
}

/** Cancels a remote session's running turn. */
export async function cancelRemoteSessionTurn(
  context: AgentSessionContext,
  address: RemoteAgentSession["address"],
): Promise<void> {
  const remote = await resolveSessionRemote(context, address);
  await cancelRemoteAgentTurn({ remote, sessionId: address.sessionId });
}

/** Ends a remote session its run is done with. */
export async function endRemoteSession(
  context: AgentSessionContext,
  address: RemoteAgentSession["address"],
): Promise<void> {
  const remote = await resolveSessionRemote(context, address);
  await resetRemoteAgentSession({
    reason: AGENT_SESSION_RUN_FINISHED_REASON,
    remote,
    sessionId: address.sessionId,
  });
}

/** A remote session keeps running where it was opened, even after the registry moves on. */
async function resolveSessionRemote(
  context: AgentSessionContext,
  address: RemoteAgentSession["address"],
): Promise<ResolvedRuntimeRemoteAgentNode> {
  const registry = remoteRegistryOf(await loadAgentRoster(context), address.name);
  const selection = context.dynamicSelections[address.nodeId];
  const resolved = resolveRemoteAgentForAction({
    // Credentials come from the binding the child was opened with, and go only to its destination.
    credentials: await credentialsOf(registry, address.nodeId, address.dynamicBinding, address),
    dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
    nodeId: address.nodeId,
    registry: registry.subagentsByNodeId,
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
  registry: RemoteRegistry,
  nodeId: string,
  binding: DynamicRemoteBinding | undefined,
  destination: { readonly name: string; readonly url: string },
): Promise<RemoteAgentCredentials | undefined> {
  if (binding === undefined) return undefined;
  return await remoteAgentCredentials({
    binding,
    destination,
    nodeId,
    resolvers: registry.dynamicResolvers,
  });
}

type RemoteRegistry = NonNullable<AgentRoster["remote"]>;

/** The registry `name`, a remote agent, resolves from: a compiled agent's only. */
function remoteRegistryOf(roster: AgentRoster, name: string): RemoteRegistry {
  if (roster.remote !== undefined) return roster.remote;
  throw new NonRetryableError(
    `Agent "${name}" is remote, which only an agent compiled from files can call.`,
  );
}
