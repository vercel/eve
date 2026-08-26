import { z } from "#compiled/zod/index.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { ResetResponseSchema, type ResetResponse } from "#protocol/reset-session.js";
import { AgentHandleError } from "#protocol/agent-handle-error.js";
import {
  createEveCallbackRoutePath,
  createEveSessionCancelRoutePath,
  createEveSessionResetRoutePath,
  createEveSessionRoutePath,
} from "#protocol/routes.js";
import type { CancelTurnResult, SessionAuthContext, SessionTraceContext } from "#channel/types.js";
import type { ForwardedPrincipal } from "#channel/forwarded-principal.js";
import type { HeadersValue } from "#client/types.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createRemoteAgentRouteUrl } from "#execution/remote-agent-route-url.js";
import { formatTraceparent } from "#protocol/traceparent.js";
import {
  formatSubagentInput,
  normalizeRequestedOutputSchema,
} from "#execution/subagent-invocation.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#shared/action-types.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import type { JsonObject } from "#shared/json.js";
import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";

const CreateSessionResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  status: z.literal("accepted"),
});

type RemoteAgentSessionCoordinates = {
  readonly sessionId: string;
};

class RemoteAgentCancelRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { readonly retryable: boolean }) {
    super(message);
    this.name = "RemoteAgentCancelRequestError";
    this.retryable = options.retryable;
  }
}

export async function startRemoteAgentSession(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  /** The dispatching turn's session principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth?: SessionAuthContext | null;
  readonly callbackBaseUrl: string | undefined;
  readonly callbackToken?: string;
  readonly eventRelay?: import("#channel/types.js").SessionEventRelayConfig;
  /** The root initiator's principal, forwarded alongside {@link auth}. */
  readonly initiatorAuth?: SessionAuthContext | null;
  /**
   * Replay-stable identity of this create attempt. A retried dispatch step
   * re-sends the same value, letting the receiver return the child it already
   * created instead of starting a second one.
   */
  readonly operationId?: string;
  readonly parentTraceContext?: SessionTraceContext;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly session: HarnessSession;
}): Promise<RemoteAgentSessionCoordinates> {
  const callbackToken = input.callbackToken ?? input.session.continuationToken;
  if (!callbackToken) {
    throw new Error("Cannot dispatch remote agent without a parent continuation token.");
  }
  if (!input.callbackBaseUrl) {
    throw new Error("Cannot dispatch remote agent without a callback base URL.");
  }

  const forwardedPrincipal = buildForwardedPrincipalField(input);
  const requestBody: {
    capabilities: {};
    callback: {
      callId: string;
      subagentName: string;
      taskId?: string;
      token: string;
      url: string;
    };
    eventRelay?: import("#channel/types.js").SessionEventRelayConfig;
    forwardedPrincipal?: ForwardedPrincipal;
    message: string;
    mode: "conversation" | "task";
    operationId?: string;
    outputSchema?: object;
  } = {
    capabilities: {},
    callback: {
      callId: input.action.callId,
      subagentName: input.action.remoteAgentName,
      taskId: readTaskIdFromInboxToken(callbackToken),
      token: callbackToken,
      url: createWorkflowCallbackUrl(
        input.callbackBaseUrl,
        createEveCallbackRoutePath(callbackToken),
      ),
    },
    message: formatRemoteAgentCallInputMessage({
      action: input.action,
      remote: input.remote,
    }),
    mode: "conversation",
    outputSchema:
      normalizeRequestedOutputSchema(input.action.input.outputSchema) ?? input.remote.outputSchema,
  };
  if (input.eventRelay !== undefined) requestBody.eventRelay = input.eventRelay;
  if (forwardedPrincipal !== undefined) {
    requestBody.forwardedPrincipal = forwardedPrincipal;
  }
  if (input.operationId !== undefined) {
    requestBody.operationId = input.operationId;
  }

  const headers = await resolveRemoteAgentRequestHeaders(input.remote);
  const traceparent = formatTraceparent(input.parentTraceContext);
  if (traceparent !== undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "traceparent") delete headers[key];
    }
    headers["traceparent"] = traceparent;
  }
  const response = await fetch(createRemoteAgentSessionUrl(input.remote), {
    body: JSON.stringify(requestBody),
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session request failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session response was not valid JSON.`,
    );
  }

  const parsed = CreateSessionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session response was invalid.`,
    );
  }

  return { sessionId: parsed.data.sessionId };
}

/** Continues one remote-agent session by its immutable session ID. */
export async function continueRemoteAgentSession(input: {
  /** The dispatching turn's session principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth: SessionAuthContext | null;
  readonly callback: {
    readonly callId: string;
    readonly subagentName: string;
    readonly taskId?: string;
    readonly token: string;
    readonly url: string;
  };
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly sessionId: string;
}): Promise<void> {
  const forwardedPrincipal = buildForwardedPrincipalField(input);
  const requestBody: {
    callback: typeof input.callback;
    forwardedPrincipal?: ForwardedPrincipal;
    message: string;
    outputSchema?: JsonObject;
  } = {
    callback: input.callback,
    message: input.message,
    outputSchema: input.outputSchema,
  };
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
    const responseCode = await readRemoteAgentErrorCode(response);
    const permanent =
      response.status === 404 || responseCode === AgentHandleError.SessionNotResumable.code;
    const compatibilityHint =
      response.status === 400 && forwardedPrincipal !== undefined
        ? " The receiver may support forwarded principals only on session creation; upgrade it before retrying."
        : "";
    throw new RemoteAgentContinueRequestError(
      `Remote agent "${input.remote.name}" continue-session request failed${
        permanent ? " permanently" : ""
      } with HTTP ${response.status}.${compatibilityHint}`,
      {
        deliveryAmbiguous: isAmbiguousRemoteContinueStatus(response.status),
        retryable: !permanent,
      },
    );
  }
}

/**
 * Failure of a continue-session request, classified at the HTTP boundary.
 * Exported so tests can exercise {@link isRetryableRemoteAgentContinueError}
 * with real instances instead of re-encoding the classification.
 */
export class RemoteAgentContinueRequestError extends Error {
  readonly deliveryAmbiguous: boolean;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly deliveryAmbiguous: boolean; readonly retryable: boolean },
  ) {
    super(message);
    this.name = "RemoteAgentContinueRequestError";
    this.deliveryAmbiguous = options.deliveryAmbiguous;
    this.retryable = options.retryable;
  }
}

/**
 * Returns true when a failed continue request may be retried. Only a
 * session that no longer exists (404 / SESSION_NOT_RESUMABLE) is permanent;
 * transient HTTP and network failures stay retryable so the dispatch step
 * keeps the agent handle and surfaces a retryable error instead of
 * discarding it — the model decides whether to try the same agentId again
 * (the step itself never re-sends: the callee may have accepted a delivery
 * whose response was lost).
 */
export function isRetryableRemoteAgentContinueError(error: unknown): boolean {
  return !(error instanceof RemoteAgentContinueRequestError) || error.retryable;
}

/** Whether the callee may have accepted the continuation before delivery failed. */
export function isAmbiguousRemoteAgentContinueError(error: unknown): boolean {
  return !(error instanceof RemoteAgentContinueRequestError) || error.deliveryAmbiguous;
}

function isAmbiguousRemoteContinueStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

async function readRemoteAgentErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const code = Reflect.get(body, "code");
  return typeof code === "string" ? code : undefined;
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
  readonly headers?: Record<string, string>;
  readonly remote: Pick<ResolvedRuntimeRemoteAgentNode, "auth" | "headers" | "name" | "url">;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly turnId?: string;
}): Promise<CancelTurnResult> {
  const headers = input.headers ?? (await resolveRemoteAgentRequestHeaders(input.remote));
  const response = await fetch(createRemoteAgentCancelTurnUrl(input.remote, input.sessionId), {
    body:
      input.turnId === undefined && input.taskId === undefined
        ? undefined
        : JSON.stringify({ taskId: input.taskId, turnId: input.turnId }),
    headers,
    method: "POST",
  });

  if (!response.ok) {
    throw new RemoteAgentCancelRequestError(
      `Remote agent "${input.remote.name}" cancel-turn request failed with HTTP ${response.status}.`,
      { retryable: isRetryableRemoteCancelStatus(response.status) },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RemoteAgentCancelRequestError(
      `Remote agent "${input.remote.name}" cancel-turn response was not valid JSON.`,
      { retryable: false },
    );
  }

  const result = CancelTurnResponseSchema.safeParse(body);
  if (
    !result.success ||
    (result.data.status === "accepted" && result.data.sessionId !== input.sessionId)
  ) {
    throw new RemoteAgentCancelRequestError(
      `Remote agent "${input.remote.name}" cancel-turn response was invalid.`,
      { retryable: false },
    );
  }

  return result.data.status === "accepted"
    ? { sessionId: result.data.sessionId, status: "accepted" }
    : { status: "no_active_turn" };
}

/** Retires one exact remote child session through eve's authenticated reset route. */
export async function resetRemoteAgentSession(input: {
  readonly headers?: Record<string, string>;
  readonly remote: Pick<ResolvedRuntimeRemoteAgentNode, "auth" | "headers" | "name" | "url">;
  readonly sessionId: string;
}): Promise<ResetResponse> {
  const headers = input.headers ?? (await resolveRemoteAgentRequestHeaders(input.remote));
  const response = await fetch(
    createRemoteAgentRouteUrl(input.remote.url, createEveSessionResetRoutePath(input.sessionId)),
    {
      body: JSON.stringify({ reason: "Parent session ended" }),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.remote.name}" reset-session request failed with HTTP ${response.status}.`,
    );
  }
  const result = ResetResponseSchema.safeParse(await response.json());
  if (
    !result.success ||
    (result.data.status === "reset" && result.data.previousSessionId !== input.sessionId)
  ) {
    throw new Error(`Remote agent "${input.remote.name}" reset-session response was invalid.`);
  }
  return result.data;
}

export function isRetryableRemoteAgentCancelError(error: unknown): boolean {
  return !(error instanceof RemoteAgentCancelRequestError) || error.retryable;
}

export function resolveRemoteAgentForAction(input: {
  readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
  readonly nodeId: string;
  readonly registry: RuntimeSubagentRegistry["subagentsByNodeId"];
  readonly remoteAgentName: string;
}): ResolvedRuntimeRemoteAgentNode {
  const registered = input.registry.get(input.nodeId);
  const definition = registered?.definition;
  if (input.dynamicRemoteAgent !== undefined) {
    if (definition === undefined) {
      throw new Error(`Missing remote agent "${input.remoteAgentName}" in runtime registry.`);
    }
    const credentials = resolveDynamicRemoteAgentCredentials(input.dynamicRemoteAgent);
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
      outputSchema?: ResolvedRuntimeRemoteAgentNode["outputSchema"];
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
      outputSchema: config.outputSchema,
      path: config.path,
      sourceId: definition.sourceId,
      sourceKind: "module",
      url: config.url,
    };
    if (config.forwardPrincipal !== undefined) {
      remote.forwardPrincipal = config.forwardPrincipal;
    }
    if (credentials.auth !== undefined) {
      remote.auth = credentials.auth;
    }
    if (credentials.headers !== undefined) {
      remote.headers = credentials.headers;
    }
    return remote;
  }
  if (definition?.kind !== "remote") {
    throw new Error(`Missing remote agent "${input.remoteAgentName}" in runtime registry.`);
  }
  return definition;
}

/**
 * Resolves authored outbound headers for a server-authored remote child event.
 *
 * `resolverId` is the key persisted on the `subagent.called` event (see
 * `SubagentCalledStreamEvent`): it identifies the authored credential
 * functions, never their resolved values. Lookup order mirrors how dispatch
 * chose the key — first as a subagent node id (static remote definition),
 * then as a `credentialsStepId` in the step registry (dynamic remote
 * definition). The matched static definition must still agree with the
 * event's `name`/`url`, so a stale or mismatched key fails closed rather
 * than minting headers for the wrong upstream.
 */
export async function resolveRemoteAgentStreamHeaders(input: {
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly name: string;
  readonly resolverId?: string;
  readonly url: string;
}): Promise<Record<string, string>> {
  if (input.resolverId === undefined) {
    return {};
  }

  const nodes = new Set([input.bundle.graph.root, ...input.bundle.graph.nodesByNodeId.values()]);
  for (const node of nodes) {
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

  const credentials = resolveDynamicRemoteAgentCredentials({
    credentialsStepId: input.resolverId,
    description: "",
    path: "",
    url: input.url,
  });
  return await resolveRemoteAgentRequestHeaders(credentials);
}

function resolveDynamicRemoteAgentCredentials(config: DynamicRemoteAgentConfig): {
  readonly auth?: ResolvedRuntimeRemoteAgentNode["auth"];
  readonly headers?: HeadersValue;
} {
  if (config.credentialsStepId === undefined) {
    return {};
  }
  const factory = getStepRegistry().get(config.credentialsStepId);
  if (factory === undefined) {
    throw new Error(
      `Dynamic remote subagent credentials function "${config.credentialsStepId}" is not registered.`,
    );
  }
  const record = expectObjectRecord(factory(), "Dynamic remote subagent credentials are invalid.");
  const credentials: {
    auth?: ResolvedRuntimeRemoteAgentNode["auth"];
    headers?: HeadersValue;
  } = {};
  if (record.auth !== undefined) {
    credentials.auth = expectFunction(record.auth, "Dynamic remote subagent auth is invalid.");
  }
  if (record.headers !== undefined) {
    credentials.headers = resolveDynamicRemoteAgentHeaders(record.headers);
  }
  return credentials;
}

function resolveDynamicRemoteAgentHeaders(value: unknown): HeadersValue {
  if (typeof value === "function") {
    return value as Exclude<HeadersValue, Readonly<Record<string, string>>>;
  }
  const record = expectObjectRecord(value, "Dynamic remote subagent headers are invalid.");
  for (const headerValue of Object.values(record)) {
    if (typeof headerValue !== "string") {
      throw new Error("Dynamic remote subagent headers are invalid.");
    }
  }
  return record as Readonly<Record<string, string>>;
}

function getStepRegistry(): Map<string, Function> {
  const key = Symbol.for("@workflow/core//registeredSteps");
  const global = globalThis as Record<symbol, Map<string, Function> | undefined>;
  let registry = global[key];
  if (registry === undefined) {
    registry = new Map();
    global[key] = registry;
  }
  return registry;
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

function isRetryableRemoteCancelStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): string {
  const message = typeof input.action.input.message === "string" ? input.action.input.message : "";
  return formatSubagentInput({
    description: input.remote.description,
    message,
    name: input.action.remoteAgentName,
    type: "remote",
  }).message;
}
