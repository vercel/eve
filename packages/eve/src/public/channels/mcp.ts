import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { z } from "#compiled/zod/index.js";
import {
  defineChannel,
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  POST,
  type Channel,
} from "#public/definitions/channel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  AgentInvocationService,
  type AgentInvocation,
} from "#internal/invocation/agent-invocation-service.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { validateMcpHttpRequest, validateMcpMetadataRequest } from "#internal/mcp/http-security.js";
import {
  createMcpStreamableHttpServer,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import {
  createMcpProtectedResourceMetadata,
  createMcpResourceChallenge,
} from "#internal/mcp/protected-resource.js";
import { inputRequestSchema, inputResponseSchema } from "#runtime/input/types.js";
import {
  escapeAuthChallengeParameter,
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
  type OAuthResourceOptions,
} from "#public/channels/auth.js";
import {
  readAgentInfoRouteResponse,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
export interface McpChannelInput {
  /** Existing eve route-auth policy. Use `none()` for explicit public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Streamable HTTP endpoint path. Defaults to `/mcp`. */
  readonly path?: string;
}

/** Public MCP channel exposing durable agent invocation compatibility tools. */
export type McpChannel = Channel;

/**
 * Publishes this agent as a stateless Streamable HTTP MCP server.
 *
 * This channel owns only MCP transport and durable eve invocation. It reuses
 * eve's inbound auth strategies and recognizes `oauthResource(...)` metadata
 * when OAuth discovery is needed.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export function mcpChannel(input: McpChannelInput): McpChannel {
  if (input?.auth === undefined) {
    throw new Error("mcpChannel requires auth. Use none() for explicit public access.");
  }
  const path = input.path ?? "/mcp";
  const oauth = readOAuthResourceOptions(input.auth);
  const routes = [
    GET(
      path,
      async (request, args) => await authenticateMcpRequest(request, args, input.auth, oauth),
    ),
    POST(
      path,
      async (request, args) => await authenticateMcpRequest(request, args, input.auth, oauth),
    ),
    DELETE(
      path,
      async (request, args) => await authenticateMcpRequest(request, args, input.auth, oauth),
    ),
  ];
  if (oauth !== undefined) {
    routes.unshift(...protectedResourceMetadataRoutes(oauth, path));
  }
  return defineChannel({ routes });
}

function protectedResourceMetadataRoutes(options: OAuthResourceOptions, resourcePath: string) {
  const metadataPath = options.metadataPath ?? "/.well-known/oauth-protected-resource";
  return [
    GET(metadataPath, async (request) =>
      protectedResourceMetadataResponse(request, options, resourcePath, false),
    ),
    HEAD(metadataPath, async (request) =>
      protectedResourceMetadataResponse(request, options, resourcePath, true),
    ),
    OPTIONS(metadataPath, async (request) => protectedResourceMetadataOptionsResponse(request)),
  ] as const;
}

function protectedResourceMetadataResponse(
  request: Request,
  options: OAuthResourceOptions,
  resourcePath: string,
  head: boolean,
): Response {
  const securityFailure = validateMcpMetadataRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const resource =
    options.resource ?? new URL(resourcePath, new URL(request.url).origin).toString();
  const authorizationServers =
    options.issuer !== undefined ? [options.issuer] : options.authorizationServers;
  const response = Response.json(
    createMcpProtectedResourceMetadata({
      authorizationServers,
      resource,
      scopesSupported: options.scopes,
    }),
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    },
  );
  return head
    ? new Response(null, { headers: response.headers, status: response.status })
    : response;
}

function protectedResourceMetadataOptionsResponse(request: Request): Response {
  const securityFailure = validateMcpMetadataRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const headers = new Headers({
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (requestedHeaders !== null) {
    headers.set("access-control-allow-headers", requestedHeaders);
    headers.set("vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { headers, status: 204 });
}

function addResourceChallenge(
  response: Response,
  request: Request,
  options: OAuthResourceOptions,
): Response {
  if (response.status !== 401 && response.status !== 403) return response;
  const metadataPath = options.metadataPath ?? "/.well-known/oauth-protected-resource";
  const publicBase = options.resource ?? new URL(request.url).origin;
  const metadataUrl = new URL(metadataPath, publicBase).toString();
  const headers = new Headers(response.headers);
  const existing = headers.get("www-authenticate");
  if (response.status === 401) {
    headers.set("www-authenticate", mergeMcpBearerChallenge(existing, metadataUrl, options.scopes));
  } else {
    const challenge = augmentInsufficientScopeChallenge(existing, metadataUrl);
    if (challenge === undefined) return response;
    headers.set("www-authenticate", challenge);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

interface ParsedAuthChallenge {
  readonly scheme: string;
  readonly value: string;
}

function mergeMcpBearerChallenge(
  header: string | null,
  metadataUrl: string,
  scopes: readonly string[] | undefined,
): string {
  const challenges = parseAuthChallenges(header);
  const bearer =
    challenges.find(
      (challenge) =>
        challenge.scheme.toLowerCase() === "bearer" && hasAuthParameter(challenge.value, "error"),
    ) ?? challenges.find((challenge) => challenge.scheme.toLowerCase() === "bearer");
  const canonical =
    bearer === undefined
      ? createMcpResourceChallenge(metadataUrl, scopes)
      : augmentBearerChallenge(bearer.value, metadataUrl, scopes);
  return replaceBearerChallenges(challenges, bearer, canonical);
}

function augmentInsufficientScopeChallenge(
  header: string | null,
  metadataUrl: string,
): string | undefined {
  const challenges = parseAuthChallenges(header);
  const bearer = challenges.find(
    (challenge) =>
      challenge.scheme.toLowerCase() === "bearer" &&
      hasAuthParameter(challenge.value, "error", "insufficient_scope"),
  );
  if (bearer === undefined) return undefined;
  return replaceBearerChallenges(
    challenges,
    bearer,
    augmentBearerChallenge(bearer.value, metadataUrl),
  );
}

function replaceBearerChallenges(
  challenges: readonly ParsedAuthChallenge[],
  selected: ParsedAuthChallenge | undefined,
  replacement: string,
): string {
  const result: string[] = [];
  let inserted = false;
  for (const challenge of challenges) {
    if (challenge.scheme.toLowerCase() !== "bearer") {
      result.push(challenge.value);
      continue;
    }
    if (!inserted && challenge === selected) {
      result.push(replacement);
      inserted = true;
    }
  }
  if (!inserted) result.push(replacement);
  return result.join(", ");
}

function augmentBearerChallenge(
  challenge: string,
  metadataUrl: string,
  scopes?: readonly string[],
): string {
  let result = challenge;
  if (!hasAuthParameter(result, "resource_metadata")) {
    result = appendAuthParameter(result, "resource_metadata", metadataUrl);
  }
  if (scopes?.length && !hasAuthParameter(result, "scope")) {
    result = appendAuthParameter(result, "scope", scopes.join(" "));
  }
  return result;
}

function appendAuthParameter(challenge: string, name: string, value: string): string {
  const separator = challenge.trim().toLowerCase() === "bearer" ? " " : ", ";
  return `${challenge}${separator}${name}="${escapeAuthChallengeParameter(value)}"`;
}

function hasAuthParameter(challenge: string, name: string, value?: string): boolean {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (value === undefined) {
    return new RegExp(`(?:^|[\\s,])${escapedName}\\s*=`, "i").test(challenge);
  }
  const escapedValue = value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[\\s,])${escapedName}\\s*=\\s*(?:"${escapedValue}"|${escapedValue})(?=$|[\\s,])`,
    "i",
  ).test(challenge);
}

function parseAuthChallenges(header: string | null): readonly ParsedAuthChallenge[] {
  if (header === null) return [];
  const challenges: Array<{ scheme: string; value: string }> = [];
  for (const part of splitQuotedHeaderList(header)) {
    const scheme = readChallengeScheme(part);
    if (scheme !== undefined) {
      challenges.push({ scheme, value: part });
      continue;
    }
    const current = challenges.at(-1);
    if (current !== undefined) current.value += `, ${part}`;
  }
  return challenges;
}

function splitQuotedHeaderList(header: string): readonly string[] {
  const parts: string[] = [];
  let escaped = false;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      const part = header.slice(start, index).trim();
      if (part.length > 0) parts.push(part);
      start = index + 1;
    }
  }
  const last = header.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function readChallengeScheme(value: string): string | undefined {
  const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s+|$)/.exec(value);
  if (match === null) return undefined;
  const scheme = match[1];
  if (scheme === undefined) return undefined;
  return value.slice(scheme.length).trimStart().startsWith("=") ? undefined : scheme;
}

async function authenticateMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  policy: AuthFn<Request> | readonly AuthFn<Request>[],
  oauth: OAuthResourceOptions | undefined,
): Promise<Response> {
  const securityFailure = validateMcpHttpRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const auth = await routeAuth(request, policy);
  if (auth instanceof Response) {
    return oauth === undefined ? auth : addResourceChallenge(auth, request, oauth);
  }
  return await handleMcpRequest(request, args, auth);
}

async function handleMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  auth: import("#channel/types.js").SessionAuthContext,
): Promise<Response> {
  const createSession = readRouteSessionCreator(args);
  const respondWithAgentInfo = readAgentInfoRouteResponse(args);
  if (createSession === undefined || respondWithAgentInfo === undefined) {
    return Response.json({ error: "MCP requires agent route context." }, { status: 500 });
  }
  const agentInfoResponse = await respondWithAgentInfo();
  if (!agentInfoResponse.ok) return agentInfoResponse;
  const agentInfo = (await agentInfoResponse.json()) as {
    readonly agent?: { readonly description?: unknown; readonly name?: unknown };
  };
  if (typeof agentInfo.agent?.name !== "string") {
    return Response.json({ error: "MCP requires compiled agent metadata." }, { status: 500 });
  }
  const description =
    typeof agentInfo.agent.description === "string" ? agentInfo.agent.description : undefined;
  const service = new AgentInvocationService(
    new WorkflowAgentInvocationExecution({
      channelName: "mcp",
      createSession,
      from: args.from,
    }),
  );
  return await createMcpStreamableHttpServer({
    authenticate: async () => auth,
    name: agentInfo.agent.name,
    tools: createInvocationTools(
      service,
      description,
      auth.authenticator === "none" && auth.principalType === "anonymous",
    ),
    version: resolveInstalledPackageInfo().version,
  })(request);
}

function createInvocationTools(
  service: AgentInvocationService,
  agentDescription: string | undefined,
  publicAccess: boolean,
): readonly McpServerTool[] {
  const publicHandleDescription = publicAccess
    ? " On this public channel, the invocation ID is a bearer capability until workflow retention expires."
    : "";
  const startDescription = `Starts durable work and returns an invocation handle immediately.${publicHandleDescription}`;
  const tools: McpServerTool[] = [
    {
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description:
          agentDescription === undefined
            ? startDescription
            : `${agentDescription} ${startDescription}`,
        inputSchema: z.strictObject({
          message: z.string().min(1),
          outputSchema: z.looseObject({}).optional(),
        }),
        name: "agent_start",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        if (typeof body.message !== "string" || body.message.length === 0)
          throw new Error("message is required.");
        const invocation = await service.create({
          auth: context.auth,
          message: body.message,
          outputSchema: asJsonObject(body.outputSchema),
        });
        return invocationResult(invocation);
      },
    },
    {
      definition: {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description: `Reads complete durable invocation state.${publicHandleDescription}`,
        inputSchema: z.strictObject({ invocationId: z.string().min(1) }),
        name: "agent_get",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.read({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
          }),
        );
      },
    },
    {
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description: "Answers a pending input request on a durable invocation.",
        inputSchema: z.strictObject({
          invocationId: z.string().min(1),
          responses: z.array(inputResponseSchema),
        }),
        name: "agent_update",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        if (!Array.isArray(body.responses)) throw new Error("responses must be an array.");
        const responses = body.responses.map((response) => inputResponseSchema.parse(response));
        return invocationResult(
          await service.update({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
            responses,
          }),
        );
      },
    },
    {
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Requests cancellation of a durable invocation. Read it again to observe acknowledgement.",
        inputSchema: z.strictObject({ invocationId: z.string().min(1) }),
        name: "agent_cancel",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.cancel({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
          }),
        );
      },
    },
  ];
  return tools;
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  const structuredContent = parseJsonObject(invocation);
  return {
    content: [{ text: JSON.stringify(structuredContent), type: "text" }],
    structuredContent,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  const schema = parseJsonObject(value);
  validateOutputSchemaComplexity(schema);
  return schema;
}

const AUTHORIZATION_CHALLENGE_SCHEMA = z.strictObject({
  displayName: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
  instructions: z.string().optional(),
  url: z.url().optional(),
  userCode: z.string().optional(),
});

const AUTHORIZATION_REQUEST_SCHEMA = z.strictObject({
  authorization: AUTHORIZATION_CHALLENGE_SCHEMA.optional(),
  description: z.string(),
  name: z.string(),
  webhookUrl: z.url().optional(),
});

const MCP_INPUT_REQUEST_SCHEMA = inputRequestSchema.safeExtend({
  action: z.strictObject({
    callId: z.string(),
    input: z.record(z.string(), z.json()),
    kind: z.literal("tool-call"),
    toolName: z.string(),
  }),
});

const AGENT_INVOCATION_OUTPUT_SCHEMA = z.strictObject({
  authorizations: z.array(AUTHORIZATION_REQUEST_SCHEMA).min(1).optional(),
  createdAt: z.iso.datetime(),
  error: z
    .strictObject({
      code: z.number().int(),
      data: z.json().optional(),
      message: z.string(),
    })
    .optional(),
  expiresAt: z.iso.datetime().optional(),
  inputRequests: z.record(z.string(), MCP_INPUT_REQUEST_SCHEMA).optional(),
  invocationId: z.string(),
  pollAfterMs: z.number().int().nonnegative().optional(),
  result: z.json().optional(),
  status: z.enum([
    "working",
    "input_required",
    "authorization_required",
    "completed",
    "failed",
    "cancelled",
  ]),
});

const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1_024;
const MAX_OUTPUT_SCHEMA_DEPTH = 32;
const MAX_OUTPUT_SCHEMA_NODES = 2_048;

function validateOutputSchemaComplexity(schema: JsonObject): void {
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new Error(`outputSchema must be at most ${String(MAX_OUTPUT_SCHEMA_BYTES)} bytes.`);
  }

  let nodes = 0;
  const visit = (value: import("#shared/json.js").JsonValue, depth: number): void => {
    nodes++;
    if (nodes > MAX_OUTPUT_SCHEMA_NODES) {
      throw new Error(
        `outputSchema must contain at most ${String(MAX_OUTPUT_SCHEMA_NODES)} nodes.`,
      );
    }
    if (depth > MAX_OUTPUT_SCHEMA_DEPTH) {
      throw new Error(
        `outputSchema must be at most ${String(MAX_OUTPUT_SCHEMA_DEPTH)} levels deep.`,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string" && !entry.startsWith("#")) {
        throw new Error("outputSchema external $ref values are not supported.");
      }
      visit(entry, depth + 1);
    }
  };

  visit(schema, 0);
}
