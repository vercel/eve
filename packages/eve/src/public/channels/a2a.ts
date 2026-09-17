import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_ROUTE,
  A2A_PROTOCOL_VERSION,
  A2ARequestError,
  inputResponses,
  invocationToTask,
  jsonRpcError,
  jsonRpcSuccess,
  messageText,
  parseClientMessage,
  type JsonRpcRequest,
} from "#internal/a2a/protocol.js";
import { validateA2AHttpRequest } from "#internal/a2a/http-security.js";
import type { AgentInvocation } from "#internal/invocation/agent-invocation.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  readAgentInfoRouteResponse,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { parseInputResponses } from "#shared/input.js";
import { parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";
import {
  isExplicitPublicAuth,
  readOAuthResourceOidcDiscoveryUrl,
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
} from "#public/channels/auth.js";
import { defineChannel, GET, POST, type Channel } from "#public/definitions/channel.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;

/** One skill advertised in the public Agent Card. */
export interface A2AAgentSkill {
  readonly description: string;
  readonly examples?: readonly string[];
  readonly id: string;
  readonly inputModes?: readonly string[];
  readonly name: string;
  readonly outputModes?: readonly string[];
  readonly tags: readonly string[];
}

/** Public Agent Card fields that eve cannot derive from compiled metadata. */
export interface A2AAgentCardOverrides {
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  readonly provider?: { readonly organization: string; readonly url: string };
  readonly skills?: readonly A2AAgentSkill[];
  readonly version?: string;
}

/** One OpenAPI-shaped Agent Card security requirement. */
export interface A2ASecurityRequirement {
  readonly schemes: Readonly<Record<string, { readonly list: readonly string[] }>>;
}

/** Auth declaration published in the Agent Card. Route auth remains authoritative. */
export type A2AChannelSecurity =
  | { readonly type: "public" }
  | {
      readonly requirements: readonly A2ASecurityRequirement[];
      readonly schemes: Readonly<Record<string, JsonObject>>;
      readonly type: "authenticated";
    };

interface A2AAgentCard extends A2AAgentCardOverrides {
  readonly capabilities: {
    readonly extendedAgentCard: false;
    readonly pushNotifications: false;
    readonly streaming: false;
  };
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly description: string;
  readonly name: string;
  readonly securityRequirements: readonly A2ASecurityRequirement[];
  readonly securitySchemes: Readonly<Record<string, JsonObject>>;
  readonly skills: readonly A2AAgentSkill[];
  readonly supportedInterfaces: readonly [
    {
      readonly protocolBinding: "JSONRPC";
      readonly protocolVersion: "1.0";
      readonly url: string;
    },
  ];
  readonly version: string;
}

export interface A2AChannelInput {
  /** Existing eve route-auth policy. Use `none()` with `security: { type: "public" }`. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Public Agent Card fields that eve cannot derive from compiled agent metadata. */
  readonly card?: A2AAgentCardOverrides;
  /** Custom Agent Card auth declaration. Derived automatically from `oauthResource(oidc(...))`. */
  readonly security?: A2AChannelSecurity;
  /** Override the default JSON-RPC route (`/eve/v1/a2a`). */
  readonly route?: string;
}

export type A2AChannel = Channel;

/** Publishes an eve agent as an A2A 1.0 JSON-RPC server. */
export function a2aChannel(input: A2AChannelInput): A2AChannel {
  if (input?.auth === undefined) {
    throw new Error("a2aChannel requires auth. Use none() for explicit public access.");
  }
  const security = resolveSecurityDeclaration(input.auth, input.security);
  const route = input.route ?? A2A_DEFAULT_ROUTE;
  return defineChannel({
    routes: [
      GET(A2A_AGENT_CARD_PATH, async (request, args) =>
        agentCardResponse(request, args, input.card, security, route),
      ),
      POST(route, async (request, args) => handleAuthenticatedRequest(request, args, input.auth)),
    ],
  });
}

async function agentCardResponse(
  request: Request,
  args: RouteHandlerArgs,
  overrides: A2AAgentCardOverrides | undefined,
  security: A2AChannelSecurity,
  route: string,
): Promise<Response> {
  const securityFailure = validateA2AHttpRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const info = readAgentInfoRouteResponse(args);
  if (info === undefined) return contextError();
  const response = await info();
  if (!response.ok) return response;
  const value = (await response.json()) as {
    readonly agent?: { readonly description?: unknown; readonly name?: unknown };
  };
  if (typeof value.agent?.name !== "string") return metadataError();
  const description =
    typeof value.agent.description === "string" ? value.agent.description : value.agent.name;
  const securityFields =
    security.type === "public"
      ? { securityRequirements: [], securitySchemes: {} }
      : { securityRequirements: security.requirements, securitySchemes: security.schemes };
  const card: {
    capabilities: A2AAgentCard["capabilities"];
    defaultInputModes: readonly string[];
    defaultOutputModes: readonly string[];
    description: string;
    documentationUrl?: string;
    iconUrl?: string;
    name: string;
    provider?: NonNullable<A2AAgentCard["provider"]>;
    securityRequirements: A2AAgentCard["securityRequirements"];
    securitySchemes: A2AAgentCard["securitySchemes"];
    skills: A2AAgentCard["skills"];
    supportedInterfaces: A2AAgentCard["supportedInterfaces"];
    version: string;
  } = {
    capabilities: {
      extendedAgentCard: false,
      pushNotifications: false,
      streaming: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    description,
    name: value.agent.name,
    ...securityFields,
    skills: overrides?.skills ?? [{ description, id: "agent", name: value.agent.name, tags: [] }],
    supportedInterfaces: [
      {
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        url: new URL(route, new URL(request.url).origin).toString(),
      },
    ],
    version: overrides?.version ?? resolveInstalledPackageInfo().version,
  };
  if (overrides?.documentationUrl !== undefined) {
    card.documentationUrl = overrides.documentationUrl;
  }
  if (overrides?.iconUrl !== undefined) card.iconUrl = overrides.iconUrl;
  if (overrides?.provider !== undefined) card.provider = overrides.provider;
  const body = JSON.stringify(card);
  const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { headers: cardHeaders(etag), status: 304 });
  }
  return new Response(body, { headers: cardHeaders(etag) });
}

async function handleAuthenticatedRequest(
  request: Request,
  args: RouteHandlerArgs,
  policy: AuthFn<Request> | readonly AuthFn<Request>[],
): Promise<Response> {
  const securityFailure = validateA2AHttpRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  if (request.headers.get("a2a-version") !== A2A_PROTOCOL_VERSION) {
    return jsonRpcError(
      null,
      new A2ARequestError(-32009, "Version not supported", "VERSION_NOT_SUPPORTED"),
    );
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => {});
    return jsonRpcError(null, new A2ARequestError(-32602, "Request body too large"));
  }
  const auth = await routeAuth(request, policy);
  if (auth instanceof Response) return auth;
  return await handleJsonRpcRequest(request, args, auth);
}

async function handleJsonRpcRequest(
  request: Request,
  args: RouteHandlerArgs,
  auth: SessionAuthContext,
): Promise<Response> {
  let id: JsonValue | null = null;
  try {
    const value = await readRequestJson(request);
    const rpc = parseJsonRpcRequest(value);
    id = rpc.id;
    const createSession = readRouteSessionCreator(args);
    if (createSession === undefined) return contextError();
    const execution = new WorkflowAgentInvocationExecution({ createSession, from: args.from });
    const result = await dispatch(rpc, execution, auth, request.signal);
    return jsonRpcSuccess(rpc.id, parseJsonValue(result));
  } catch (error) {
    return jsonRpcError(id, error);
  }
}

async function dispatch(
  request: JsonRpcRequest,
  execution: WorkflowAgentInvocationExecution,
  auth: SessionAuthContext,
  signal: AbortSignal,
): Promise<unknown> {
  const params = request.params;
  if (isRecord(params) && params.tenant !== undefined) {
    throw new A2ARequestError(-32602, "Invalid parameters");
  }
  switch (request.method) {
    case "SendMessage":
      return await sendMessage(request.params, execution, auth, signal);
    case "GetTask": {
      const params = recordParams(request.params);
      const id = requiredString(params.id);
      const invocation = await execution.read({ auth, invocationId: id });
      if (invocation === undefined) throw taskNotFound();
      return invocationToTask(invocation);
    }
    case "CancelTask": {
      const params = recordParams(request.params);
      const id = requiredString(params.id);
      const before = await execution.read({ auth, invocationId: id });
      if (before === undefined) throw taskNotFound();
      if (isTerminal(before)) {
        throw new A2ARequestError(-32002, "Task not cancelable", "TASK_NOT_CANCELABLE");
      }
      const invocation = await execution.cancel({ auth, invocationId: id });
      if (invocation === undefined) throw taskNotFound();
      return invocationToTask(invocation);
    }
    case "ListTasks":
      throw new A2ARequestError(-32004, "Operation not supported", "UNSUPPORTED_OPERATION");
    case "SendStreamingMessage":
    case "SubscribeToTask":
      throw new A2ARequestError(-32004, "Operation not supported", "UNSUPPORTED_OPERATION");
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
      throw new A2ARequestError(
        -32003,
        "Push notifications not supported",
        "PUSH_NOTIFICATION_NOT_SUPPORTED",
      );
    case "GetExtendedAgentCard":
      throw new A2ARequestError(-32004, "Operation not supported", "UNSUPPORTED_OPERATION");
    default:
      throw new A2ARequestError(-32601, "Method not found");
  }
}

async function sendMessage(
  value: unknown,
  execution: WorkflowAgentInvocationExecution,
  auth: SessionAuthContext,
  signal: AbortSignal,
): Promise<{ readonly task: ReturnType<typeof invocationToTask> }> {
  const params = recordParams(value);
  const message = parseClientMessage(params.message);
  const configuration = parseSendMessageConfiguration(params.configuration);
  let invocation: AgentInvocation;
  if (message.taskId === undefined) {
    if (message.contextId !== undefined) {
      throw new A2ARequestError(-32004, "Operation not supported", "UNSUPPORTED_OPERATION");
    }
    invocation = await execution.create({ auth, message: messageText(message) });
  } else {
    const current = await execution.read({ auth, invocationId: message.taskId });
    if (current === undefined) throw taskNotFound();
    if (message.contextId !== undefined && message.contextId !== message.taskId) {
      throw new A2ARequestError(-32602, "Invalid parameters");
    }
    if (current.status !== "input_required") {
      throw new A2ARequestError(-32004, "Operation not supported", "UNSUPPORTED_OPERATION");
    }
    const responses = resolveInputResponses(message, current);
    const updated = await execution.update({ auth, invocationId: message.taskId, responses });
    if (updated.type === "not_found") throw taskNotFound();
    if (updated.type === "conflict") throw new A2ARequestError(-32602, updated.message);
    invocation = updated.invocation;
  }
  if (configuration.returnImmediately !== true) {
    invocation = await waitForInterruption(execution, auth, invocation.invocationId, signal);
  }
  return { task: invocationToTask(invocation) };
}

function resolveInputResponses(
  message: ReturnType<typeof parseClientMessage>,
  invocation: Extract<AgentInvocation, { readonly status: "input_required" }>,
) {
  const structured = inputResponses(message);
  if (structured !== undefined) return parseInputResponses(structured);
  const requests = Object.values(invocation.inputRequests);
  const text = message.parts.length === 1 ? message.parts[0]?.text : undefined;
  if (requests.length === 1 && text !== undefined) {
    return parseInputResponses([{ requestId: requests[0]!.requestId, text }]);
  }
  throw new A2ARequestError(-32602, "Message must answer the complete pending input batch.");
}

async function waitForInterruption(
  execution: WorkflowAgentInvocationExecution,
  auth: SessionAuthContext,
  invocationId: string,
  signal: AbortSignal,
): Promise<AgentInvocation> {
  while (!signal.aborted) {
    const invocation = await execution.read({ auth, invocationId });
    if (invocation === undefined) throw taskNotFound();
    if (invocation.status !== "working") return invocation;
    await delay(POLL_INTERVAL_MS, signal);
  }
  throw new A2ARequestError(-32603, "Request aborted while waiting for the task.");
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readRequestJson(request: Request): Promise<unknown> {
  const body = request.body;
  if (body === null) throw new A2ARequestError(-32700, "Invalid JSON payload");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    await body.cancel().catch(() => {});
    throw new A2ARequestError(-32602, "Request body too large");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      throw new A2ARequestError(-32602, "Request body too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new A2ARequestError(-32700, "Invalid JSON payload");
  }
}

function parseSendMessageConfiguration(value: unknown): { readonly returnImmediately?: boolean } {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new A2ARequestError(-32602, "Invalid parameters");
  if (value.returnImmediately !== undefined && typeof value.returnImmediately !== "boolean") {
    throw new A2ARequestError(-32602, "Invalid parameters");
  }
  if (value.taskPushNotificationConfig !== undefined) {
    throw new A2ARequestError(
      -32003,
      "Push notifications not supported",
      "PUSH_NOTIFICATION_NOT_SUPPORTED",
    );
  }
  return value.returnImmediately === undefined
    ? {}
    : { returnImmediately: value.returnImmediately };
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    throw new A2ARequestError(-32600, "Request payload validation error");
  }
  if (!isJsonRpcId(value.id)) {
    throw new A2ARequestError(-32600, "Request payload validation error");
  }
  return { id: value.id, jsonrpc: "2.0", method: value.method, params: value.params };
}

function recordParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new A2ARequestError(-32602, "Invalid parameters");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new A2ARequestError(-32602, "Invalid parameters");
  }
  return value;
}

function taskNotFound(): A2ARequestError {
  return new A2ARequestError(-32001, "Task not found", "TASK_NOT_FOUND");
}

function isTerminal(invocation: AgentInvocation): boolean {
  return ["completed", "failed", "cancelled"].includes(invocation.status);
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSecurityDeclaration(
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
  authored: A2AChannelSecurity | undefined,
): A2AChannelSecurity {
  if (authored !== undefined) {
    validateSecurityDeclaration(authored);
    return authored;
  }
  if (isExplicitPublicAuth(auth)) return { type: "public" };
  const oauth = readOAuthResourceOptions(auth);
  const discoveryUrl = readOAuthResourceOidcDiscoveryUrl(auth);
  if (oauth === undefined || discoveryUrl === undefined) {
    throw new Error("a2aChannel requires security unless auth is oauthResource(oidc(...), ...).");
  }
  const scopes = oauth.requiredScopes ?? [];
  return {
    requirements: [{ schemes: { oidc: { list: scopes } } }],
    schemes: {
      oidc: { openIdConnectSecurityScheme: { openIdConnectUrl: discoveryUrl } },
    },
    type: "authenticated",
  };
}

function validateSecurityDeclaration(security: A2AChannelSecurity): void {
  if (security.type === "public") return;
  const schemeNames = Object.keys(security.schemes);
  if (schemeNames.length === 0 || security.requirements.length === 0) {
    throw new Error(
      "Authenticated A2A channels require at least one security scheme and requirement.",
    );
  }
  for (const requirement of security.requirements) {
    const requiredSchemes = Object.keys(requirement.schemes);
    if (requiredSchemes.length === 0) {
      throw new Error("A2A security requirements must reference at least one scheme.");
    }
    for (const scheme of requiredSchemes) {
      if (!Object.hasOwn(security.schemes, scheme)) {
        throw new Error(`A2A security requirement references unknown scheme "${scheme}".`);
      }
    }
  }
}

function cardHeaders(etag: string): Headers {
  return new Headers({
    "cache-control": "public, max-age=300",
    "content-type": "application/json",
    etag,
  });
}

function contextError(): Response {
  return Response.json({ error: "A2A requires agent route context." }, { status: 500 });
}

function metadataError(): Response {
  return Response.json({ error: "A2A requires compiled agent metadata." }, { status: 500 });
}
