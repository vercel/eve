import { createHash } from "node:crypto";
import { defineChannel, GET, POST, type Channel } from "#public/definitions/channel.js";
import { routeAuth, type AuthFn } from "#public/channels/auth.js";
import {
  readAgentInfoRouteResponse,
  readRouteChannelName,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { agentCardSchema, A2A_VERSION, type A2AAgentCard } from "#internal/a2a/protocol.js";
import { handleA2ARequest } from "#internal/a2a/server.js";
import { isLoopbackHostname } from "#shared/network-address.js";

/** Public metadata to include in this agent's A2A 1.0 Agent Card. */
export type A2ACardOptions = Partial<
  Pick<
    A2AAgentCard,
    | "name"
    | "description"
    | "version"
    | "provider"
    | "documentationUrl"
    | "iconUrl"
    | "skills"
    | "securitySchemes"
    | "securityRequirements"
  >
>;
export interface A2AChannelInput {
  /** Authenticate every operation. Use `none()` to explicitly allow public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Public card metadata. Authenticated routes require matching security declarations. */
  readonly card?: A2ACardOptions;
  /** JSON-RPC endpoint. Defaults to `/eve/v1/a2a`. */
  readonly route?: string;
}
/** Exposes durable tasks using A2A 1.0 JSON-RPC, polling, and SSE. */
export function a2aChannel(input: A2AChannelInput): Channel {
  if (input?.auth === undefined)
    throw new Error("a2aChannel requires auth. Use none() for explicit public access.");
  const policies = Array.isArray(input.auth) ? input.auth : [input.auth];
  const publicAccess = policies.some(
    (policy) => Reflect.get(policy, Symbol.for("eve.channels.auth.none")) === true,
  );
  if (!publicAccess && (!input.card?.securitySchemes || !input.card.securityRequirements?.length)) {
    throw new Error(
      "a2aChannel requires card.securitySchemes and card.securityRequirements matching its auth policy.",
    );
  }
  for (const requirement of input.card?.securityRequirements ?? []) {
    for (const name of Object.keys(requirement.schemes)) {
      if (!Object.hasOwn(input.card?.securitySchemes ?? {}, name))
        throw new Error(`Unknown A2A security scheme: ${name}`);
    }
  }
  const path = input.route ?? "/eve/v1/a2a";
  if (!path.startsWith("/") || path.startsWith("//") || /[?#]/.test(path))
    throw new Error("A2A route must be an absolute URL path.");
  return defineChannel({
    routes: [
      GET("/.well-known/agent-card.json", async (request, args) => {
        const info = await readAgentInfoRouteResponse(args)?.();
        if (info === undefined || !info.ok)
          return Response.json({ error: "Agent metadata unavailable." }, { status: 500 });
        const metadata = (await info.json()) as { agent?: { name?: string; description?: string } };
        const name = input.card?.name ?? metadata.agent?.name ?? "agent";
        const description = input.card?.description ?? metadata.agent?.description ?? "";
        const card = agentCardSchema.parse({
          ...input.card,
          name,
          description,
          version: input.card?.version ?? "1.0.0",
          supportedInterfaces: [
            {
              url: new URL(path, request.url).toString(),
              protocolBinding: "JSONRPC",
              protocolVersion: A2A_VERSION,
            },
          ],
          capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
          defaultInputModes: ["text/plain", "application/json"],
          defaultOutputModes: ["text/plain", "application/json"],
          skills: input.card?.skills ?? [{ id: "agent", name, description, tags: [] }],
          securityRequirements: publicAccess ? [] : input.card?.securityRequirements,
        });
        const body = JSON.stringify(card);
        const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
        const headers = {
          "cache-control": "public, max-age=300",
          etag,
          "content-type": "application/json",
        };
        return request.headers.get("if-none-match") === etag
          ? new Response(null, { status: 304, headers })
          : new Response(body, { headers });
      }),
      POST(path, async (request, args) => {
        const url = new URL(request.url);
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
        )
          return new Response("HTTPS required.", { status: 403 });
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== url.origin)
          return new Response("Invalid origin.", { status: 403 });
        const auth = await routeAuth(request, input.auth);
        if (auth instanceof Response) return auth;
        const createSession = readRouteSessionCreator(args);
        const channelName = readRouteChannelName(args);
        if (createSession === undefined || channelName === undefined)
          return new Response("Agent route context unavailable.", { status: 500 });
        return handleA2ARequest(request, {
          auth,
          execution: new WorkflowAgentInvocationExecution({
            createSession,
            from: args.from,
            scope: `a2a:${channelName}`,
          }),
        });
      }),
    ],
  });
}
