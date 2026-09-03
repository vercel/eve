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
import type {
  AgentInvocation,
  AgentInvocationMutationResult,
} from "#internal/invocation/agent-invocation.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { validateMcpHttpRequest, validateMcpMetadataRequest } from "#internal/mcp/http-security.js";
import {
  createMcpStreamableHttpServer,
  defineMcpTool,
  McpToolOperationError,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import {
  createMcpProtectedResourceMetadata,
  createMcpResourceChallenge,
} from "#internal/mcp/protected-resource.js";
import { inputRequestSchema, inputResponseSchema } from "#shared/input.js";
import {
  escapeAuthChallengeParameter,
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
  type OAuthResourceOptions,
} from "#public/channels/auth.js";
import {
  readAgentInfoRouteResponse,
  readRouteChannelName,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
export interface McpChannelInput {
  /** Existing eve route-auth policy. Use `none()` for explicit public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Override the default MCP route path (`/eve/v1/mcp`). */
  readonly route?: string;
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
  const path = input.route ?? "/eve/v1/mcp";
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
  const metadataPath = protectedResourceMetadataPath(options, resourcePath);
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

function protectedResourceMetadataPath(
  options: OAuthResourceOptions,
  resourcePath: string,
): string {
  if (options.metadataPath !== undefined) return options.metadataPath;
  const path = options.resource === undefined ? resourcePath : new URL(options.resource).pathname;
  return path === "/"
    ? "/.well-known/oauth-protected-resource"
    : `/.well-known/oauth-protected-resource${path}`;
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
  const metadataPath = protectedResourceMetadataPath(options, new URL(request.url).pathname);
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
  const channelName = readRouteChannelName(args);
  const respondWithAgentInfo = readAgentInfoRouteResponse(args);
  if (
    channelName === undefined ||
    createSession === undefined ||
    respondWithAgentInfo === undefined
  ) {
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
  const execution = new WorkflowAgentInvocationExecution({
    createSession,
    from: args.from,
  });
  return await createMcpStreamableHttpServer({
    authenticate: async () => auth,
    instructions: MCP_SERVER_INSTRUCTIONS,
    name: agentInfo.agent.name,
    tools: createInvocationTools(
      execution,
      description,
      auth.authenticator === "none" && auth.principalType === "anonymous",
    ),
    version: resolveInstalledPackageInfo().version,
  })(request);
}

/**
 * Hosted MCP clients receive this once per connection (legacy `initialize`)
 * or per discovery (`server/discover`). Keep it short: clients truncate or
 * drop long instructions, and the details live in each tool description.
 */
const MCP_SERVER_INSTRUCTIONS = [
  "Each invocation is one durable agent task.",
  "Call agent_start once per task and keep the returned invocationId.",
  "Poll agent_get, waiting at least pollAfterMs between calls, until status is completed, failed, or cancelled.",
  "If status is input_required, answer every entry in inputRequests in one agent_update call; repeating accepted answers is safe.",
  "If status is authorization_required, show the user the authorization url or instructions and keep polling.",
  "isError on a tool result means your call was rejected; a failed status means the task failed.",
  "agent_start is not idempotent and a lost response leaves no invocationId, so ask the user before starting again.",
  "Work continues after your connection drops; agent_cancel stops it, then poll until any terminal status.",
].join(" ");

function createInvocationTools(
  execution: WorkflowAgentInvocationExecution,
  agentDescription: string | undefined,
  publicAccess: boolean,
): readonly McpServerTool[] {
  const publicHandleDescription = publicAccess
    ? " On this public channel, the invocation ID is a bearer capability until workflow retention expires."
    : "";
  const startDescription =
    "Starts durable work and returns an invocation handle immediately. " +
    "Call once per task; keep invocationId and poll agent_get. Not idempotent: if the response is lost, " +
    `ask the user before starting again rather than retrying.${publicHandleDescription}`;
  const tools: McpServerTool[] = [
    defineMcpTool({
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
      async call(body, context) {
        const invocation = await execution.create({
          auth: context.auth,
          message: body.message,
          outputSchema: asJsonObject(body.outputSchema),
        });
        return invocationResult(invocation);
      },
    }),
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description:
          "Reads complete durable invocation state. Wait at least pollAfterMs between calls. " +
          "Terminal statuses are completed, failed, and cancelled. input_required needs agent_update; " +
          `authorization_required needs the user to follow the returned authorization.${publicHandleDescription}`,
        inputSchema: z.strictObject({ invocationId: z.string().min(1) }),
        name: "agent_get",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        return invocationResult(
          requiredInvocation(
            await execution.read({
              auth: context.auth,
              invocationId: body.invocationId,
            }),
          ),
        );
      },
    }),
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description:
          "Answers the pending input batch on an input_required invocation. Include one response per " +
          "entry in inputRequests, each keyed by its requestId, in a single call; partial batches are rejected. " +
          "Returns the current invocation state; repeating the same accepted answers is safe.",
        inputSchema: z.strictObject({
          invocationId: z.string().min(1),
          responses: z.array(inputResponseSchema).min(1),
        }),
        name: "agent_update",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        return invocationResult(
          requiredMutation(
            await execution.update({
              auth: context.auth,
              invocationId: body.invocationId,
              responses: body.responses,
            }),
          ),
        );
      },
    }),
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Requests cooperative cancellation of a non-terminal invocation. Cancellation is asynchronous and " +
          "can race with completion: poll agent_get until status is terminal (cancelled, completed, or failed). " +
          "Safe to call repeatedly.",
        inputSchema: z.strictObject({ invocationId: z.string().min(1) }),
        name: "agent_cancel",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        return invocationResult(
          requiredInvocation(
            await execution.cancel({
              auth: context.auth,
              invocationId: body.invocationId,
            }),
          ),
        );
      },
    }),
  ];
  return tools;
}

// Unknown, expired, and foreign-principal invocations all read as not found
// so the response never confirms that another caller's invocation exists.
const INVOCATION_NOT_FOUND =
  "Invocation not found. It may have expired or belong to another caller.";

function requiredInvocation(invocation: AgentInvocation | undefined): AgentInvocation {
  if (invocation === undefined) {
    throw new McpToolOperationError("not_found", INVOCATION_NOT_FOUND);
  }
  return invocation;
}

function requiredMutation(result: AgentInvocationMutationResult): AgentInvocation {
  switch (result.type) {
    case "success":
      return result.invocation;
    case "conflict":
      throw new McpToolOperationError(
        "conflict",
        `${result.message} Call agent_get to read the current state before answering again.`,
      );
    case "not_found":
      throw new McpToolOperationError("not_found", INVOCATION_NOT_FOUND);
  }
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  const structuredContent = parseJsonObject(invocation);
  return {
    content: [{ text: JSON.stringify(structuredContent), type: "text" }],
    structuredContent,
  };
}

function asJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  try {
    const schema = parseJsonObject(value);
    validateOutputSchemaComplexity(schema);
    return schema;
  } catch (error) {
    throw new McpToolOperationError(
      "invalid_input",
      error instanceof Error ? error.message : "outputSchema must be a JSON object.",
    );
  }
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

const AGENT_INVOCATION_BASE_SCHEMA = z.strictObject({
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  invocationId: z.string(),
});

const AGENT_INVOCATION_OUTPUT_SCHEMA = z.discriminatedUnion("status", [
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    pollAfterMs: z.number().int().nonnegative(),
    result: z.json().optional(),
    status: z.literal("working"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    inputRequests: z.record(z.string(), MCP_INPUT_REQUEST_SCHEMA),
    result: z.json().optional(),
    status: z.literal("input_required"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    authorizations: z.array(AUTHORIZATION_REQUEST_SCHEMA).min(1),
    pollAfterMs: z.number().int().nonnegative(),
    result: z.json().optional(),
    status: z.literal("authorization_required"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    result: z.json().optional(),
    status: z.literal("completed"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    error: z.strictObject({
      code: z.number().int(),
      data: z.json().optional(),
      message: z.string(),
    }),
    status: z.literal("failed"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({ status: z.literal("cancelled") }),
]);

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
