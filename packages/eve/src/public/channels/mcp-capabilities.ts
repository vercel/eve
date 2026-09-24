import { createHash } from "node:crypto";

import { ResourceNotFoundError, Server } from "#compiled/@modelcontextprotocol/server/index.js";
import { z } from "#compiled/zod/index.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  authorizeCapabilityApprovalResponse,
  evaluateCapabilityApproval,
  executeCapabilityTool,
  MAX_CAPABILITY_SESSION_KEY_LENGTH,
  readCapabilitySandboxStatus,
  recordCapabilityAuthorizationAttempts,
  recordCapabilityAuthorizationCallback,
  resolveCapabilitySessionScope,
  takeCapabilityAuthorizationResults,
  warmCapabilitySandbox,
  withCapabilitySession,
  type CapabilityRuntime,
  type CapabilitySessionScope,
  type CapabilityToolOutcome,
} from "#execution/capability-session.js";
import { projectAuthorizationCallback } from "#execution/connections/callback-route.js";
import type { AuthorizationSignal } from "#harness/authorization.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger, logError } from "#internal/logging.js";
import { validateMcpHttpRequest } from "#internal/mcp/http-security.js";
import {
  addResourceChallenge,
  protectedResourceMetadataRoutes,
} from "#internal/mcp/oauth-routes.js";
import {
  listSkillResources,
  MCP_SKILL_FILE_MAX_BYTES,
  parseSkillResourceUri,
  skillFileContents,
  skillResourceTemplates,
} from "#internal/mcp/skill-resources.js";
import { serveMcpHttpRequest } from "#internal/mcp/streamable-http-server.js";
import { readRouteCapabilityRuntime } from "#internal/nitro/routes/channel-route-context.js";
import {
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
  type OAuthResourceOptions,
} from "#public/channels/auth.js";
import { defineChannel, GET, POST, type Channel } from "#public/definitions/channel.js";
import { buildAuthorizationCompletePage } from "#runtime/connections/authorization-complete-page.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { parseJsonObject, parseJsonValue, type JsonObject } from "#shared/json.js";
import { serializeInputSchema, serializeOutputSchema } from "#tools/schema.js";
import { createUlid } from "#shared/ulid.js";

const log = createLogger("channel.mcp-capabilities");

const DEFAULT_ROUTE = "/eve/v1/mcp-capabilities";
const SESSION_HEADER = "eve-capability-session";
const SESSION_META_KEY = "eve.dev/session";
const APPROVAL_INPUT_KEY = "approval";

export interface McpCapabilitiesChannelInput {
  /** Existing eve route-auth policy. Use `none()` for explicit public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Override the default route path (`/eve/v1/mcp-capabilities`). */
  readonly route?: string;
}

/** Public MCP channel exposing this agent's own tools and skills. */
export type McpCapabilitiesChannel = Channel;

/**
 * Publishes this agent's compiled tools and skills as a stateless MCP server
 * (protocol 2026-07-28, JSON responses).
 *
 * `tools/call` runs the real tool executor server-side inside an eve context:
 * `ctx.getSandbox()`, `ctx.getSkill()`, `ctx.getToken()`, and
 * `ctx.session.auth` work as they do in the model loop. Callers scope sandbox
 * reuse with an `eve-capability-session` header (or
 * `params._meta["eve.dev/session"]`); the key is bound to the authenticated
 * principal. Approvals and interactive sign-in return MCP input-required
 * results. Skills are `skill://<agent>/<skill>` resources.
 *
 * Framework tools, workflow tools, and `execution: "background"` tools are not
 * exposed.
 */
export function mcpCapabilitiesChannel(input: McpCapabilitiesChannelInput): McpCapabilitiesChannel {
  if (input?.auth === undefined) {
    throw new Error("mcpCapabilitiesChannel requires auth. Use none() for explicit public access.");
  }
  const path = input.route ?? DEFAULT_ROUTE;
  const oauth = readOAuthResourceOptions(input.auth);
  const callbackPath = `${path}/authorize/:name/:attemptId`;
  const routes = [
    POST(
      path,
      async (request, args) =>
        await authenticateCapabilitiesRequest(request, args, input.auth, oauth, path),
    ),
    GET(callbackPath, handleAuthorizationCallback),
    POST(callbackPath, handleAuthorizationCallback),
  ];
  if (oauth !== undefined) routes.unshift(...protectedResourceMetadataRoutes(oauth, path));
  return defineChannel({ routes });
}

async function authenticateCapabilitiesRequest(
  request: Request,
  args: RouteHandlerArgs,
  policy: AuthFn<Request> | readonly AuthFn<Request>[],
  oauth: OAuthResourceOptions | undefined,
  path: string,
): Promise<Response> {
  const securityFailure = validateMcpHttpRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const auth = await routeAuth(request, policy);
  if (auth instanceof Response) {
    return oauth === undefined ? auth : addResourceChallenge(auth, request, oauth);
  }
  const resolveRuntime = readRouteCapabilityRuntime(args);
  if (resolveRuntime === undefined) {
    return Response.json(
      { error: "MCP capabilities require agent route context." },
      { status: 500 },
    );
  }
  return await handleCapabilitiesRequest({
    args,
    auth,
    callbackBase: new URL(path, new URL(request.url).origin).toString(),
    request,
    runtime: await resolveRuntime(),
  });
}

interface CapabilitiesRequest {
  readonly args: RouteHandlerArgs;
  readonly auth: SessionAuthContext;
  readonly callbackBase: string;
  readonly request: Request;
  readonly runtime: CapabilityRuntime;
}

async function handleCapabilitiesRequest(input: CapabilitiesRequest): Promise<Response> {
  let method: unknown;
  let scope: CapabilitySessionScope | undefined;
  const response = await serveMcpHttpRequest(input.request, (body) => {
    method = readRecord(body)?.method;
    scope = resolveCapabilitySessionScope(input.auth, readSessionKey(input.request, body));
    return createCapabilitiesServer(input, scope);
  });
  if (method !== "server/discover" || scope === undefined || !response.ok) return response;
  return await annotateDiscover(input, scope, response);
}

/**
 * Reports sandbox readiness on `server/discover` and starts provisioning
 * without delaying the response, so the first `tools/call` finds it warm.
 */
async function annotateDiscover(
  input: CapabilitiesRequest,
  scope: CapabilitySessionScope,
  response: Response,
): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const status = readCapabilitySandboxStatus(input.runtime, scope);
  if (status === "warming") {
    input.args.waitUntil(
      warmCapabilitySandbox({ auth: input.auth, runtime: input.runtime, scope }),
    );
  }
  const body = readRecord(await response.json());
  const result = readRecord(body?.result);
  if (body === undefined || result === undefined) {
    return Response.json(body, { headers: response.headers, status: response.status });
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(
    {
      ...body,
      result: { ...result, _meta: { ...readRecord(result._meta), "eve.dev/sandbox": status } },
    },
    { headers, status: response.status },
  );
}

function readSessionKey(request: Request, body: unknown): string | undefined {
  const fromMeta = readRecord(readRecord(readRecord(body)?.params)?._meta)?.[SESSION_META_KEY];
  const key = typeof fromMeta === "string" ? fromMeta : request.headers.get(SESSION_HEADER);
  if (key === null || key === undefined) return undefined;
  const trimmed = key.trim();
  return trimmed.length === 0 || trimmed.length > MAX_CAPABILITY_SESSION_KEY_LENGTH
    ? undefined
    : trimmed;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function createCapabilitiesServer(input: CapabilitiesRequest, scope: CapabilitySessionScope) {
  const { runtime } = input;
  const tools = new Map(
    runtime.tools.flatMap((tool) => {
      const descriptor = describeTool(runtime.agentName, tool);
      return descriptor === undefined ? [] : [[tool.name, { descriptor, tool }] as const];
    }),
  );
  const server = new Server(
    { name: runtime.agentName, version: resolveInstalledPackageInfo().version },
    {
      capabilities: { resources: {}, tools: { listChanged: false } },
      instructions: runtime.description,
    },
  );

  server.setRequestHandler("tools/list", () => ({
    tools: [...tools.values()].map((entry) => entry.descriptor),
  }));

  server.setRequestHandler("tools/call", async (request, context) => {
    const entry = tools.get(request.params.name);
    if (entry === undefined) return toolError(`Unknown tool: ${request.params.name}`);
    return await callTool({
      arguments: request.params.arguments ?? {},
      inputResponses: context.mcpReq.inputResponses ?? {},
      rawRequestState: context.mcpReq.requestState(),
      request: input,
      scope,
      signal: context.mcpReq.signal,
      tool: entry.tool,
    });
  });

  server.setRequestHandler("resources/list", () => ({
    resources: listSkillResources(runtime.agentName, runtime.skills),
  }));

  server.setRequestHandler("resources/templates/list", () => ({
    resourceTemplates: skillResourceTemplates(runtime.agentName),
  }));

  server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri;
    const parsed = parseSkillResourceUri(runtime.agentName, runtime.skills, uri);
    if (parsed === undefined) throw new ResourceNotFoundError(uri);
    if (parsed.path === undefined) {
      if (new TextEncoder().encode(parsed.skill.markdown).byteLength > MCP_SKILL_FILE_MAX_BYTES) {
        throw new Error("SKILL.md exceeds the MCP size limit.");
      }
      return { contents: [{ mimeType: "text/markdown", text: parsed.skill.markdown, uri }] };
    }
    const bytes = await readSkillFile(input, scope, parsed.skill.name, parsed.path);
    if (bytes === undefined) throw new ResourceNotFoundError(uri);
    return { contents: [skillFileContents(uri, parsed.path, bytes)] };
  });

  return server;
}

interface McpToolDescriptor {
  readonly _meta: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
  outputSchema?: JsonObject;
}

function describeTool(
  agentName: string,
  tool: ResolvedToolDefinition,
): McpToolDescriptor | undefined {
  const inputSchema: JsonObject =
    tool.inputSchema === null ? { type: "object" } : serializeInputSchema(tool.inputSchema);
  if (inputSchema.type !== "object") {
    log.warn("tool input schema is not an object; omitting from MCP capabilities", {
      toolName: tool.name,
    });
    return undefined;
  }
  const descriptor: McpToolDescriptor = {
    _meta: { "eve.dev/approval": tool.approval !== undefined, "eve.dev/owner": agentName },
    description: tool.description,
    inputSchema,
    name: tool.name,
  };
  const outputSchema = serializeOutputSchema(tool.outputSchema);
  // MCP output schemas describe structuredContent, which is always an object.
  if (outputSchema?.type === "object") descriptor.outputSchema = outputSchema;
  return descriptor;
}

async function readSkillFile(
  input: CapabilitiesRequest,
  scope: CapabilitySessionScope,
  skillName: string,
  path: string,
): Promise<Uint8Array | undefined> {
  const fromDisk = await input.runtime.readSkillFile?.(skillName, path);
  if (fromDisk !== undefined) return fromDisk;
  if (!input.runtime.hasSandbox) return undefined;
  return await withCapabilitySession(
    { auth: input.auth, defer: input.args.waitUntil, runtime: input.runtime, scope },
    async () => await buildCallbackContext().getSkill(skillName).file(path).bytes(),
  ).catch((error: unknown) => {
    logError(log, "skill file read failed", error, { path, skillName });
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

interface ToolCallInput {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly inputResponses: Readonly<Record<string, unknown>>;
  readonly rawRequestState: unknown;
  readonly request: CapabilitiesRequest;
  readonly scope: CapabilitySessionScope;
  readonly signal: AbortSignal;
  readonly tool: ResolvedToolDefinition;
}

async function callTool(input: ToolCallInput) {
  const { request, scope, tool } = input;
  const args = input.arguments;
  const argsHash = hashArguments(args);
  const state =
    input.rawRequestState === undefined ? undefined : decodeRequestState(input.rawRequestState);
  if (
    state === null ||
    (state !== undefined && (state.s !== scope.id || state.t !== tool.name || state.h !== argsHash))
  ) {
    return toolError(
      "requestState does not belong to this tool call. Retry with the original arguments, or without requestState to start over.",
    );
  }
  const callId = state?.c ?? `call_${createUlid()}`;
  const baseState = { c: callId, h: argsHash, s: scope.id, t: tool.name, v: 1 as const };

  try {
    return await withCapabilitySession(
      {
        auth: request.auth,
        authorizationResults:
          state?.k === "authorization"
            ? takeCapabilityAuthorizationResults(scope.id, state.a ?? [])
            : undefined,
        callbackUrl: (name, attemptId) =>
          `${request.callbackBase}/authorize/${encodeURIComponent(name)}/${encodeURIComponent(attemptId)}`,
        defer: request.args.waitUntil,
        runtime: request.runtime,
        scope,
      },
      async () => {
        let approved = state?.p === true;
        if (state?.k === "approval") {
          if (!isApprovalAccepted(input.inputResponses[APPROVAL_INPUT_KEY])) {
            return toolError(`The user declined to run ${tool.name}.`);
          }
          const response = await authorizeCapabilityApprovalResponse({
            args,
            auth: request.auth,
            callId,
            tool,
          });
          if (response.kind === "denied") {
            return toolError(response.reason ?? `Approval for ${tool.name} was rejected.`);
          }
          approved = true;
        }
        if (!approved) {
          const decision = await evaluateCapabilityApproval({
            abortSignal: input.signal,
            args,
            callId,
            tool,
          });
          if (decision.kind === "denied") {
            return toolError(decision.reason ?? `${tool.name} is not allowed for this request.`);
          }
          if (decision.kind === "user-approval") {
            return inputRequired(
              { [APPROVAL_INPUT_KEY]: approvalElicitation(tool, args) },
              { ...baseState, k: "approval" },
            );
          }
        }

        const outcome = await executeCapabilityTool({
          abortSignal: input.signal,
          args,
          callId,
          tool,
        });
        if (outcome.kind === "authorization-required") {
          const attemptIds = recordCapabilityAuthorizationAttempts(scope.id, outcome.signal);
          return inputRequired(authorizationElicitations(outcome.signal), {
            ...baseState,
            a: attemptIds,
            k: "authorization",
            p: true,
          });
        }
        if (outcome.kind === "invalid-input") {
          return toolError(`Invalid arguments for ${tool.name}: ${outcome.message}`);
        }
        return toolResult(outcome);
      },
    );
  } catch (error) {
    // Tool errors are authored messages the model would see in the loop; the
    // remote caller stands in for that model. Everything goes to the log too.
    const errorId = logError(log, "capability tool call failed", error, { toolName: tool.name });
    const message = error instanceof Error && error.message ? error.message : "Tool call failed.";
    return toolError(`${message} (errorId: ${errorId})`);
  }
}

function toolResult(outcome: Extract<CapabilityToolOutcome, { kind: "output" }>) {
  const result: {
    readonly content: ReturnType<typeof toMcpContent>;
    structuredContent?: JsonObject;
  } = { content: toMcpContent(outcome.modelOutput) };
  const structuredContent = toStructuredContent(outcome.output);
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function toolError(text: string) {
  return { content: [{ text, type: "text" as const }], isError: true };
}

function toStructuredContent(output: unknown): JsonObject | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  try {
    return parseJsonObject(output);
  } catch {
    return undefined;
  }
}

function toMcpContent(output: Extract<CapabilityToolOutcome, { kind: "output" }>["modelOutput"]) {
  switch (output.type) {
    case "text":
      return [{ text: output.value, type: "text" as const }];
    case "json":
      return [{ text: JSON.stringify(output.value), type: "text" as const }];
    case "content":
      return output.value.map((part) => {
        if (part.type === "text") return { text: part.text, type: "text" as const };
        const data = part.data.type === "data" ? part.data.data : "";
        if (part.mediaType.startsWith("image/")) {
          return { data, mimeType: part.mediaType, type: "image" as const };
        }
        if (part.mediaType.startsWith("audio/")) {
          return { data, mimeType: part.mediaType, type: "audio" as const };
        }
        return {
          resource: {
            blob: data,
            mimeType: part.mediaType,
            uri: `attachment:///${encodeURIComponent(part.filename ?? "file")}`,
          },
          type: "resource" as const,
        };
      });
  }
}

// ---------------------------------------------------------------------------
// Multi-round-trip input
// ---------------------------------------------------------------------------

/**
 * Opaque retry state. Unsigned by design for this surface: the client that
 * relays it is the same principal who answers the embedded requests, and the
 * server re-checks session, tool, and argument binding on every retry.
 */
const requestStateSchema = z.strictObject({
  a: z.array(z.string().max(64)).max(16).optional(),
  c: z.string().max(64),
  h: z.string().length(64),
  k: z.enum(["approval", "authorization"]),
  p: z.boolean().optional(),
  s: z.string().length(64),
  t: z.string().max(256),
  v: z.literal(1),
});

type RequestState = z.infer<typeof requestStateSchema>;

function encodeRequestState(state: RequestState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

/** Returns `null` for present-but-invalid state. */
function decodeRequestState(raw: unknown): RequestState | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const parsed = requestStateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function inputRequired(inputRequests: Record<string, unknown>, state: RequestState) {
  return {
    inputRequests,
    requestState: encodeRequestState(state),
    resultType: "input_required" as const,
  };
}

function approvalElicitation(
  tool: ResolvedToolDefinition,
  args: Readonly<Record<string, unknown>>,
) {
  return {
    method: "elicitation/create",
    params: {
      message: `Approve running ${tool.name}? ${tool.description}\nArguments: ${JSON.stringify(args)}`,
      mode: "form",
      requestedSchema: {
        properties: {
          approved: {
            description: `Allow ${tool.name} to run with these arguments.`,
            title: "Approve",
            type: "boolean",
          },
        },
        required: ["approved"],
        type: "object",
      },
    },
  };
}

function isApprovalAccepted(response: unknown): boolean {
  const record = readRecord(response);
  return record?.action === "accept" && readRecord(record.content)?.approved === true;
}

function authorizationElicitations(signal: AuthorizationSignal): Record<string, unknown> {
  const requests: Record<string, unknown> = {};
  for (const [index, entry] of signal.challenges.entries()) {
    const { challenge } = entry;
    const displayName = challenge.displayName ?? entry.name;
    const message = [
      `Sign in to ${displayName} to continue.`,
      challenge.instructions,
      challenge.userCode === undefined ? undefined : `Code: ${challenge.userCode}`,
    ]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" ");
    requests[`authorization:${entry.name}:${String(index)}`] =
      challenge.url === undefined
        ? {
            method: "elicitation/create",
            params: {
              message,
              mode: "form",
              requestedSchema: {
                properties: { completed: { title: "Signed in", type: "boolean" } },
                type: "object",
              },
            },
          }
        : {
            method: "elicitation/create",
            params: { message, mode: "url", url: challenge.url },
          };
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Authorization callback
// ---------------------------------------------------------------------------

async function handleAuthorizationCallback(
  request: Request,
  args: RouteHandlerArgs,
): Promise<Response> {
  const name = args.params.name;
  const attemptId = args.params.attemptId;
  if (!name || !attemptId) {
    return Response.json({ error: "Missing authorization attempt.", ok: false }, { status: 400 });
  }
  const recorded = recordCapabilityAuthorizationCallback({
    attemptId,
    callback: await projectAuthorizationCallback(request),
    name,
  });
  if (!recorded) {
    // Another instance may own the attempt. Provider-owned grants still
    // resolve on the client's retry, so the user can continue either way.
    log.warn("authorization callback for unknown attempt", { name });
  }
  return buildAuthorizationCompletePage();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashArguments(args: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(canonicalJson(parseJsonValue(args)))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
