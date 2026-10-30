import { normalizeAgentMessage } from "#execution/agent-sessions/message.js";
import type { MessageContent } from "#shared/message-content.js";
import { FatalError } from "#compiled/@workflow/core/index.js";
import { z } from "#compiled/zod/index.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { ResetResponseSchema, type ResetResponse } from "#protocol/reset-session.js";
import {
  REMOTE_AGENT_PROTOCOL_MISMATCH,
  REMOTE_AGENT_PROTOCOL_VERSION,
  formatRemoteAgentProtocolMismatch,
  readRemoteAgentProtocolVersion,
  callbackUrlForProtocol,
  servesRemoteAgentCaller,
  V26_INPUT_REMOTE_AGENT_PROTOCOL,
} from "#protocol/remote-agent-protocol.js";
import {
  createEveCallbackRoutePath,
  createEveSessionCancelRoutePath,
  createEveSessionResetRoutePath,
  createEveSessionRoutePath,
} from "#protocol/routes.js";
import type {
  CancelTurnResult,
  SessionAuthContext,
  SessionCapabilities,
  SessionTraceSeed,
} from "#channel/types.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { ForwardedPrincipal } from "#channel/forwarded-principal.js";
import type { HeadersValue } from "#client/types.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createRemoteAgentRouteUrl } from "#subagents/remote-route-url.js";
import { formatTraceparent, writeAgentDispatchTracestate } from "#protocol/traceparent.js";
import { formatSubagentInput, type SubagentParentContext } from "#subagents/invocation.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeRemoteAgentDispatchRequest } from "#shared/action-types.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type {
  DynamicRemoteAgentConfig,
  RemoteAgentCredentials,
} from "#runtime/subagents/dynamic-remote-agent-config.js";
import { remoteAgentCredentials } from "#execution/agent-sessions/remote-credentials.js";
import type { DynamicRemoteBinding } from "#reactions/remote.js";
import type { JsonValue } from "#shared/json.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { Answer } from "#shared/input.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import {
  writeForwardedAudienceBaggage,
  writeForwardedParentSessionBaggage,
} from "#protocol/baggage.js";
import { decisionToTraceContentCeiling } from "#shared/forwarded-trace-policy.js";
import { writeConversationBaggage } from "#tracing/eve/conversation-context.js";
import { agentDelegation } from "#tracing/eve/delegation.js";

const DeliveryReceiptResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1),
});

const ProtocolRejectionSchema = z.object({
  code: z.literal(REMOTE_AGENT_PROTOCOL_MISMATCH),
  ok: z.unknown().optional(),
  protocolVersion: z.unknown().optional(),
  sessionId: z.unknown().optional(),
});

const RemoteCancelResponseSchema = z.union([
  DeliveryReceiptResponseSchema.transform(({ sessionId }) => ({
    sessionId,
    status: "accepted" as const,
  })),
  CancelTurnResponseSchema,
]);

const RemoteResetResponseSchema = z.union([
  DeliveryReceiptResponseSchema.transform(({ sessionId }) => ({
    ok: true as const,
    previousSessionId: sessionId,
    status: "reset" as const,
  })),
  ResetResponseSchema,
]);

const CreateSessionResponseSchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.number().optional(),
    sessionId: z.string().min(1),
  })
  .and(
    z.union([
      z.object({ deliveryId: z.string().min(1) }),
      // Earlier protocol peers acknowledge creation without naming the delivery.
      z.object({ status: z.literal("accepted") }),
    ]),
  );

const UNKNOWN_REMOTE_OUTCOME =
  "The request may have completed on the remote agent. Do not retry automatically; check the remote outcome before sending the request again.";

type RemoteAgentSessionCoordinates = {
  readonly sessionId: string;
  /** The first message's delivery, which earlier-protocol receivers don't name. */
  readonly deliveryId?: string;
  /** The child's protocol, when it speaks an earlier one: its result arrives, nothing else. */
  readonly earlierProtocol?: number;
};

export async function startRemoteAgentSession(input: {
  readonly action: RuntimeRemoteAgentDispatchRequest;
  /** The dispatching turn's session principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth?: SessionAuthContext | null;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities?: SessionCapabilities;
  readonly originAudience?: ChannelAudience;
  /** The root initiator's principal, forwarded alongside {@link auth}. */
  readonly initiatorAuth?: SessionAuthContext | null;
  /**
   * Replay-stable identity of this create attempt. A retried dispatch step
   * re-sends the same value, letting the receiver return the child it already
   * created instead of starting a second one.
   */
  readonly operationId?: string;
  readonly parent?: Omit<SubagentParentContext, "lineage"> & {
    readonly lineage?: SubagentParentContext["lineage"];
  };
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly session: Pick<HarnessSession, "continuationToken">;
}): Promise<RemoteAgentSessionCoordinates> {
  const callbackToken = input.parent?.continuationToken ?? input.session.continuationToken;
  if (!callbackToken) {
    throw new Error("Cannot dispatch remote agent without a parent continuation token.");
  }
  if (!input.callbackBaseUrl) {
    throw new Error("Cannot dispatch remote agent without a callback base URL.");
  }

  const forwardedPrincipal = buildForwardedPrincipalField(input);
  const requestBody: {
    capabilities: SessionCapabilities;
    callback: {
      callId: string;
      subagentName: string;
      token: string;
      url: string;
    };
    forwardedPrincipal?: ForwardedPrincipal;
    message: MessageContent<string | URL>;
    operationId?: string;
    outputSchema?: object;
    protocolVersion: number;
  } = {
    capabilities: input.capabilities ?? {},
    callback: {
      callId: input.action.callId,
      subagentName: input.action.remoteAgentName,
      token: callbackToken,
      url: callbackUrlForProtocol(
        createWorkflowCallbackUrl(input.callbackBaseUrl, createEveCallbackRoutePath(callbackToken)),
        REMOTE_AGENT_PROTOCOL_VERSION,
      ),
    },
    message: formatRemoteAgentCallInputMessage({
      action: input.action,
      remote: input.remote,
    }),
    // `ctx.agent` already dropped an empty schema, so what arrives is one to honor.
    outputSchema: input.action.input.outputSchema as JsonObject | undefined,
    protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
  };
  if (forwardedPrincipal !== undefined) {
    requestBody.forwardedPrincipal = forwardedPrincipal;
  }
  if (input.operationId !== undefined) {
    requestBody.operationId = input.operationId;
  }

  const post = async (): Promise<Response> => {
    const headers = await resolveRemoteAgentRequestHeaders(input.remote);
    const traceparent = formatTraceparent(input.parent?.traceContext);
    if (traceparent !== undefined) setHeader(headers, "traceparent", traceparent);
    setHeader(
      headers,
      "tracestate",
      writeAgentDispatchTracestate(readHeader(headers, "tracestate"), input.parent?.traceContext),
    );
    const baggage = writeForwardedAudienceBaggage(
      readHeader(headers, "baggage"),
      buildForwardedTraceAssertion({
        forwardedPrincipal,
        originAudience: input.originAudience,
        parentTraceContext: input.parent?.traceContext,
        traceparent,
      }),
    );
    const conversationBaggage = writeConversationBaggage(baggage, input.parent?.conversationId);
    setHeader(
      headers,
      "baggage",
      writeForwardedParentSessionBaggage(conversationBaggage, input.parent?.lineage),
    );
    return agentDelegation.fetch(createRemoteAgentSessionUrl(input.remote), {
      body: JSON.stringify(requestBody),
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    });
  };
  let response = await post();
  let rejected = response.ok ? undefined : await readProtocolRejection(response);
  if (
    response.status === 409 &&
    rejected?.refusedBeforeAdmission &&
    servesRemoteAgentCaller(rejected.version) &&
    rejected.version < REMOTE_AGENT_PROTOCOL_VERSION
  ) {
    requestBody.protocolVersion = rejected.version;
    // The same callback, marked with the protocol it now agrees to.
    requestBody.callback.url = callbackUrlForProtocol(requestBody.callback.url, rejected.version);
    response = await post();
    rejected = response.ok ? undefined : await readProtocolRejection(response);
  }

  if (!response.ok) {
    if (rejected)
      throw new FatalError(
        formatRemoteAgentProtocolMismatch({
          name: input.action.remoteAgentName,
          receiverVersion: rejected.version,
        }),
      );
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session request failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FatalError(
      `Remote agent "${input.action.remoteAgentName}" create-session response was not valid JSON. ${UNKNOWN_REMOTE_OUTCOME}`,
    );
  }

  const parsed = CreateSessionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new FatalError(
      `Remote agent "${input.action.remoteAgentName}" create-session response was invalid. ${UNKNOWN_REMOTE_OUTCOME}`,
    );
  }
  const receiverVersion = readRemoteAgentProtocolVersion(parsed.data.protocolVersion);
  if (!servesRemoteAgentCaller(receiverVersion)) {
    throw new FatalError(
      `${formatRemoteAgentProtocolMismatch({ name: input.action.remoteAgentName, receiverVersion })} ${UNKNOWN_REMOTE_OUTCOME} Remote session: ${parsed.data.sessionId}.`,
    );
  }

  if (receiverVersion !== REMOTE_AGENT_PROTOCOL_VERSION)
    return { earlierProtocol: receiverVersion, sessionId: parsed.data.sessionId };
  return "deliveryId" in parsed.data
    ? { deliveryId: parsed.data.deliveryId, sessionId: parsed.data.sessionId }
    : { sessionId: parsed.data.sessionId };
}

async function readProtocolRejection(response: Response) {
  const parsed = ProtocolRejectionSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return undefined;
  return {
    version: readRemoteAgentProtocolVersion(parsed.data.protocolVersion),
    refusedBeforeAdmission:
      parsed.data.ok === false &&
      parsed.data.sessionId === undefined &&
      typeof parsed.data.protocolVersion === "number",
  };
}

function buildForwardedTraceAssertion(input: {
  readonly forwardedPrincipal: ForwardedPrincipal | undefined;
  readonly originAudience: ChannelAudience | undefined;
  readonly parentTraceContext: SessionTraceSeed | undefined;
  readonly traceparent: string | undefined;
}) {
  const ceiling = decisionToTraceContentCeiling(input.parentTraceContext?.decision);
  if (
    input.forwardedPrincipal === undefined ||
    input.parentTraceContext === undefined ||
    (input.parentTraceContext.traceFlags & 1) !== 1 ||
    input.traceparent === undefined ||
    ceiling === undefined
  ) {
    return undefined;
  }
  return {
    ceiling,
    originAudience: input.originAudience ?? "unknown",
  };
}

export async function respondToRemoteAgentSession(input: {
  readonly remote: RemoteAgentBinding & { readonly sessionId: string };
  readonly headers: Record<string, string>;
  readonly auth: SessionAuthContext | null | undefined;
  /**
   * Names this set of answers, so a retried step's repeat is the same delivery to the child.
   * Only a child on this protocol accepts it.
   */
  readonly idempotencyKey?: string;
  readonly responses: readonly Answer[];
}): Promise<void> {
  const response = await fetch(
    createRemoteAgentRouteUrl(input.remote.url, createEveSessionRoutePath(input.remote.sessionId)),
    {
      body: JSON.stringify({
        // A protocol 2 child takes answers as v26 responses, each naming the request it answers.
        ...(input.remote.earlierProtocol === V26_INPUT_REMOTE_AGENT_PROTOCOL
          ? {
              inputResponses: input.responses.map(({ interactionId, optionId, text }) => ({
                requestId: interactionId,
                ...(optionId !== undefined && { optionId }),
                ...(text !== undefined && { text }),
              })),
            }
          : { answers: input.responses }),
        ...(input.remote.earlierProtocol === undefined &&
          input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        ...(input.remote.forwardPrincipal === true &&
          input.auth != null && {
            forwardedPrincipal: { current: input.auth },
          }),
      }),
      headers: { "content-type": "application/json", ...input.headers },
      method: "POST",
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(
      `Remote agent "${input.remote.name}" input answer failed with HTTP ${response.status}.`,
    );
}

/** Continues one remote-agent session by its immutable session ID. */
export async function continueRemoteAgentSession(input: {
  /** The dispatching turn's session principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth: SessionAuthContext | null;
  readonly callback: {
    readonly callId: string;
    readonly subagentName: string;
    readonly token: string;
    readonly url: string;
  };
  readonly earlierProtocol?: number;
  /**
   * Names this message, so a retried step's repeat is the same delivery and returns the same
   * receipt. Only a child on this protocol accepts it.
   */
  readonly idempotencyKey?: string;
  readonly message: MessageContent<string | URL>;
  readonly outputSchema?: JsonObject;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly sessionId: string;
}): Promise<{ readonly sessionId: string; readonly deliveryId?: string }> {
  const forwardedPrincipal = buildForwardedPrincipalField(input);
  const requestBody: {
    callback: typeof input.callback;
    forwardedPrincipal?: ForwardedPrincipal;
    idempotencyKey?: string;
    message: MessageContent<string | URL>;
    outputSchema?: JsonObject;
  } = {
    callback: {
      ...input.callback,
      url: callbackUrlForProtocol(
        input.callback.url,
        input.earlierProtocol ?? REMOTE_AGENT_PROTOCOL_VERSION,
      ),
    },
    message: input.message,
    outputSchema: input.outputSchema,
  };
  // Earlier protocols reject fields they don't know.
  if (input.earlierProtocol === undefined && input.idempotencyKey !== undefined) {
    requestBody.idempotencyKey = input.idempotencyKey;
  }
  if (forwardedPrincipal !== undefined) {
    requestBody.forwardedPrincipal = forwardedPrincipal;
  }
  const response = await fetch(createRemoteAgentContinueUrl(input.remote, input.sessionId), {
    body: JSON.stringify(requestBody),
    headers: {
      "content-type": "application/json",
      ...(await resolveRemoteAgentRequestHeaders(input.remote)),
    },
    method: "POST",
  });

  if (!response.ok) {
    const compatibilityHint =
      response.status === 400 && forwardedPrincipal !== undefined
        ? " The receiver may support forwarded principals only on session creation; upgrade it before retrying."
        : "";
    throw new Error(
      `Remote agent "${input.remote.name}" continue-session request failed with HTTP ${response.status}.${compatibilityHint}`,
    );
  }
  // An earlier-protocol receiver's reply isn't read: it names no delivery the parent records.
  if (input.earlierProtocol !== undefined) return { sessionId: input.sessionId };
  const receipt = DeliveryReceiptResponseSchema.safeParse(await response.json().catch(() => null));
  if (!receipt.success) {
    throw new Error(
      `Remote agent "${input.remote.name}" continue-session response was not a delivery receipt. The message may have been accepted.`,
    );
  }
  return { deliveryId: receipt.data.deliveryId, sessionId: receipt.data.sessionId };
}

function buildForwardedPrincipalField(input: {
  readonly auth?: SessionAuthContext | null;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): ForwardedPrincipal | undefined {
  if (input.remote.forwardPrincipal !== true) {
    return undefined;
  }
  // No current principal (the request was accepted with no credentials):
  // proceed on transport trust alone.
  if (input.auth === null || input.auth === undefined) {
    return undefined;
  }
  const field: { current: SessionAuthContext; initiator?: SessionAuthContext } = {
    current: input.auth,
  };
  if (input.initiatorAuth !== null && input.initiatorAuth !== undefined) {
    field.initiator = input.initiatorAuth;
  }
  return field;
}

export async function cancelRemoteAgentTurn(input: {
  readonly remote: Pick<ResolvedRuntimeRemoteAgentNode, "auth" | "headers" | "name" | "url">;
  readonly sessionId: string;
}): Promise<CancelTurnResult> {
  const response = await fetch(createRemoteAgentCancelTurnUrl(input.remote, input.sessionId), {
    headers: await resolveRemoteAgentRequestHeaders(input.remote),
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.remote.name}" cancel-turn request failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Remote agent "${input.remote.name}" cancel-turn response was not valid JSON.`);
  }

  const result = RemoteCancelResponseSchema.safeParse(body);
  if (
    !result.success ||
    (result.data.status === "accepted" && result.data.sessionId !== input.sessionId)
  ) {
    throw new Error(`Remote agent "${input.remote.name}" cancel-turn response was invalid.`);
  }

  return result.data.status === "accepted"
    ? { sessionId: result.data.sessionId, status: "accepted" }
    : { status: "no_active_turn" };
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function setHeader(headers: Record<string, string>, name: string, value: string | undefined): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
  if (value !== undefined) headers[name] = value;
}

/** Retires one exact remote child session through eve's authenticated reset route. */
export async function resetRemoteAgentSession(input: {
  readonly reason: string;
  readonly remote: Pick<ResolvedRuntimeRemoteAgentNode, "auth" | "headers" | "name" | "url">;
  readonly sessionId: string;
}): Promise<ResetResponse> {
  const headers = await resolveRemoteAgentRequestHeaders(input.remote);
  const response = await fetch(
    createRemoteAgentRouteUrl(input.remote.url, createEveSessionResetRoutePath(input.sessionId)),
    {
      body: JSON.stringify({ reason: input.reason }),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.remote.name}" reset-session request failed with HTTP ${response.status}.`,
    );
  }
  const result = RemoteResetResponseSchema.safeParse(await response.json());
  if (
    !result.success ||
    (result.data.status === "reset" && result.data.previousSessionId !== input.sessionId)
  ) {
    throw new Error(`Remote agent "${input.remote.name}" reset-session response was invalid.`);
  }
  return result.data;
}

export function resolveRemoteAgentForAction(input: {
  readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
  /** A dynamic remote agent's credentials, built again from its child's binding. */
  readonly credentials?: RemoteAgentCredentials;
  readonly nodeId: string;
  readonly registry: RuntimeSubagentRegistry["subagentsByNodeId"];
  readonly remoteAgentName: string;
}): ResolvedRuntimeRemoteAgentNode {
  const registered = input.registry.get(input.nodeId);
  const definition = registered?.definition;
  if (input.dynamicRemoteAgent !== undefined) {
    if (definition === undefined) {
      throw new FatalError(`Missing remote agent "${input.remoteAgentName}" in runtime registry.`);
    }
    const config = input.dynamicRemoteAgent;
    const remote: {
      auth?: ResolvedRuntimeRemoteAgentNode["auth"];
      description: string;
      forwardPrincipal?: boolean;
      headers?: HeadersValue;
      kind: "remote";
      logicalPath: string;
      name: string;
      nodeId: string;
      path: string;
      sourceId: string;
      sourceKind: "module";
      url: string;
    } = {
      description: config.description,
      kind: "remote",
      logicalPath: definition.logicalPath,
      name: input.remoteAgentName,
      nodeId: input.nodeId,
      path: config.path,
      sourceId: definition.sourceId,
      sourceKind: "module",
      url: config.url,
    };
    if (config.forwardPrincipal !== undefined) {
      remote.forwardPrincipal = config.forwardPrincipal;
    }
    if (input.credentials?.auth !== undefined) remote.auth = input.credentials.auth;
    if (input.credentials?.headers !== undefined) remote.headers = input.credentials.headers;
    return remote;
  }
  if (definition?.kind !== "remote") {
    throw new FatalError(`Missing remote agent "${input.remoteAgentName}" in runtime registry.`);
  }
  return definition;
}

/**
 * Resolves authored outbound headers for a server-authored remote child event.
 *
 * `resolverId` is the key the parent's private child binding records: the subagent's node id,
 * never resolved credentials. A static remote agent's definition must still agree with the
 * event's `name`/`url`, and a dynamic one's credentials are built again from the binding the
 * child was opened with, for the same destination, so a stale or mismatched key fails closed
 * rather than minting headers for the wrong upstream.
 */
export async function resolveRemoteAgentStreamHeaders(input: {
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly name: string;
  readonly resolverId?: string;
  readonly url: string;
  /** A dynamic remote agent's binding, from the parent's binding for the child. */
  readonly dynamicBinding?: JsonValue | DynamicRemoteBinding;
}): Promise<Record<string, string>> {
  if (input.resolverId === undefined) {
    return {};
  }

  const nodes = new Set([input.bundle.graph.root, ...input.bundle.graph.nodesByNodeId.values()]);
  for (const node of nodes) {
    const { dynamicNodeIds, dynamicResolvers } = node.subagentRegistry;
    if (dynamicNodeIds.has(input.resolverId)) {
      // A dynamic remote agent without credentials keeps no binding.
      if (input.dynamicBinding === undefined) return {};
      return await resolveRemoteAgentRequestHeaders(
        await remoteAgentCredentials({
          binding: input.dynamicBinding as DynamicRemoteBinding,
          destination: { name: input.name, url: input.url },
          nodeId: input.resolverId,
          resolvers: dynamicResolvers,
        }),
      );
    }
    const definition = node.subagentRegistry.subagentsByNodeId.get(input.resolverId)?.definition;
    if (definition === undefined) continue;
    if (
      definition.kind !== "remote" ||
      definition.name !== input.name ||
      definition.url !== input.url
    ) {
      throw new Error("Remote child stream resolver does not match the authored remote agent.");
    }
    return await resolveRemoteAgentRequestHeaders(definition);
  }

  throw new Error("This remote child's stream doesn't match an authored remote agent.");
}

function createRemoteAgentSessionUrl(remote: ResolvedRuntimeRemoteAgentNode): string {
  return createRemoteAgentRouteUrl(remote.url, remote.path);
}

function createRemoteAgentCancelTurnUrl(
  remote: Pick<ResolvedRuntimeRemoteAgentNode, "url">,
  sessionId: string,
): string {
  return createRemoteAgentRouteUrl(remote.url, createEveSessionCancelRoutePath(sessionId));
}

function createRemoteAgentContinueUrl(
  remote: ResolvedRuntimeRemoteAgentNode,
  sessionId: string,
): string {
  return createRemoteAgentRouteUrl(remote.url, createEveSessionRoutePath(sessionId));
}

async function resolveRemoteAgentRequestHeaders(
  remote: Pick<ResolvedRuntimeRemoteAgentNode, "auth" | "headers">,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (remote.headers !== undefined) {
    Object.assign(
      headers,
      typeof remote.headers === "function" ? await remote.headers() : remote.headers,
    );
  }
  if (remote.auth !== undefined) {
    Object.assign(headers, (await remote.auth()).headers);
  }
  return headers;
}

function formatRemoteAgentCallInputMessage(input: {
  readonly action: RuntimeRemoteAgentDispatchRequest;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): MessageContent<string | URL> {
  const message = normalizeAgentMessage(input.action.input.message as MessageContent<string | URL>);
  return formatSubagentInput({
    description: input.remote.description,
    message,
    name: input.action.remoteAgentName,
    type: "remote",
  }).message;
}
