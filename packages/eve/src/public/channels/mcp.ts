import type { JsonObject } from "#shared/json.js";
import type { AuthFn } from "#public/channels/auth.js";
import { routeAuth } from "#public/channels/auth.js";
import { defineChannel, DELETE, GET, POST, type Channel } from "#public/definitions/channel.js";
import { readRouteAgent } from "#internal/nitro/routes/channel-route-context.js";
import {
  AgentInvocationConflictError,
  AgentInvocationNotFoundError,
  AgentInvocationService,
  type AgentInvocation,
} from "#internal/invocation/agent-invocation-service.js";
import { WorkflowAgentInvocationRepository } from "#internal/invocation/workflow-invocation-repository.js";
import {
  createMcpStreamableHttpServer,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import {
  createMcpAuthChallenge,
  createMcpProtectedResourceMetadata,
} from "#internal/mcp/protected-resource.js";
import { inputResponseSchema } from "#runtime/input/types.js";

export interface McpChannelInput {
  readonly agent: {
    readonly description: string;
    readonly maxWaitMs?: number;
    readonly outputSchema?: JsonObject;
  };
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  readonly oauth: {
    readonly authorizationServers: readonly string[];
    readonly resource: string;
    readonly scopesSupported?: readonly string[];
  };
}

/** Public MCP channel exposing durable agent invocation compatibility tools. */
export interface McpChannel extends Channel {}

/**
 * Publishes this agent as a protected, stateless Streamable HTTP MCP server.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export function mcpChannel(input: McpChannelInput): McpChannel {
  const metadataUrl = protectedResourceMetadataUrl(input.oauth.resource);
  const authenticate = async (request: Request) => {
    const result = await routeAuth(request, input.auth);
    return result instanceof Response ? createMcpAuthChallenge(metadataUrl) : result;
  };

  return defineChannel({
    routes: [
      GET("/.well-known/oauth-protected-resource", async () =>
        Response.json(createMcpProtectedResourceMetadata(input.oauth), {
          headers: { "cache-control": "no-store" },
        }),
      ),
      POST("/mcp", async (request, args) => {
        const requestAuth = await authenticate(request);
        if (requestAuth instanceof Response) return requestAuth;
        const agent = readRouteAgent(args);
        if (agent === undefined) {
          return Response.json(
            { error: "MCP requires internal channel dispatch context." },
            { status: 500 },
          );
        }
        const service = new AgentInvocationService(
          new WorkflowAgentInvocationRepository(agent, "mcp"),
          { maxWaitMs: input.agent.maxWaitMs },
        );
        return await createMcpStreamableHttpServer({
          authenticate: async () => requestAuth,
          name: "eve-agent",
          tools: createInvocationTools(service, input.agent),
          version: "1.0.0",
        })(request);
      }),
      DELETE("/mcp", async (request) => {
        const auth = await authenticate(request);
        if (auth instanceof Response) return auth;
        return Response.json(
          {
            error: { code: -32600, message: "This stateless MCP server has no session to delete." },
            id: null,
            jsonrpc: "2.0",
          },
          { status: 405 },
        );
      }),
    ],
  });
}

function createInvocationTools(
  service: AgentInvocationService,
  config: McpChannelInput["agent"],
): readonly McpServerTool[] {
  const tools: McpServerTool[] = [
    {
      definition: {
        description: `${config.description} Starts durable work and returns an invocation handle immediately.`,
        inputSchema: {
          additionalProperties: false,
          properties: {
            idempotencyKey: { type: "string" },
            message: { type: "string" },
            outputSchema: { type: "object" },
          },
          required: ["message"],
          type: "object",
        },
        name: "agent_start",
      },
      async call(value, context) {
        const body = record(value);
        if (typeof body.message !== "string" || body.message.length === 0)
          throw new Error("message is required.");
        const invocation = await service.create({
          auth: context.auth,
          idempotencyKey: optionalString(body.idempotencyKey, "idempotencyKey"),
          message: body.message,
          outputSchema: asJsonObject(body.outputSchema) ?? config.outputSchema,
        });
        return invocationResult(invocation);
      },
    },
    {
      definition: {
        description:
          "Reads complete durable invocation state. Optionally waits for its revision to change.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            afterRevision: { minimum: 0, type: "integer" },
            invocationId: { type: "string" },
            waitMs: { minimum: 0, type: "integer" },
          },
          required: ["invocationId"],
          type: "object",
        },
        name: "agent_get",
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.read({
            afterRevision: optionalInteger(body.afterRevision, "afterRevision"),
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
            waitMs: optionalInteger(body.waitMs, "waitMs"),
          }),
        );
      },
    },
    {
      definition: {
        description: "Answers a pending input request on a durable invocation.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            invocationId: { type: "string" },
            responses: { items: { type: "object" }, type: "array" },
          },
          required: ["invocationId", "responses"],
          type: "object",
        },
        name: "agent_update",
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
        description:
          "Requests cancellation of a durable invocation. Read it again to observe acknowledgement.",
        inputSchema: {
          additionalProperties: false,
          properties: { invocationId: { type: "string" } },
          required: ["invocationId"],
          type: "object",
        },
        name: "agent_cancel",
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
  return tools.map(wrapInvocationErrors);
}

function wrapInvocationErrors(tool: McpServerTool): McpServerTool {
  return {
    ...tool,
    async call(input, context) {
      try {
        return await tool.call(input, context);
      } catch (error) {
        if (error instanceof AgentInvocationNotFoundError) throw new Error("Invocation not found.");
        if (error instanceof AgentInvocationConflictError) throw error;
        throw error;
      }
    },
  };
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  const structuredContent = JSON.parse(JSON.stringify(invocation)) as Record<string, unknown>;
  return {
    content: [{ text: JSON.stringify(invocation), type: "text" }],
    structuredContent,
  };
}

function protectedResourceMetadataUrl(resource: string): string {
  return new URL("/.well-known/oauth-protected-resource", resource).toString();
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
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}
function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  return value as number;
}
function asJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  return record(value) as JsonObject;
}
