/**
 * Experimental: publish this agent as an A2A (Agent2Agent) v1.0 server over the JSON-RPC binding.
 *
 * This API has no compatibility promise and may change with the A2A specification.
 */
import {
  admitsAnonymousCallers,
  declaredAuthChallenges,
  readOAuthResourceOptions,
} from "#channel/auth/definitions.js";
import { sessionAuthFromResult } from "#channel/auth/result.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  buildAgentCard,
  type A2aAgentCardOptions,
  type CardSecurity,
} from "#internal/a2a/agent-card.js";
import { A2aTaskExecution } from "#internal/a2a/execution.js";
import { handleA2aJsonRpc } from "#internal/a2a/json-rpc.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { validateMcpHttpRequest, validateMcpMetadataRequest } from "#internal/mcp/http-security.js";
import { readRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { routeAuth, type AuthFn } from "#public/channels/auth.js";
import {
  mergeUploadPolicy,
  type UploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import { defineChannel, GET, OPTIONS, POST, type Channel } from "#public/definitions/channel.js";

export type { A2aAgentCardOptions, A2aAgentSkill } from "#internal/a2a/agent-card.js";

export interface A2aChannelConfig {
  /**
   * Who may call the agent: an eve route-auth policy. Each A2A context belongs to the principal
   * that started it. Use `none()` for explicit public access, where every anonymous caller is one
   * principal and context and task IDs are the only thing keeping callers apart.
   */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** JSON-RPC endpoint path. @default "/eve/v1/a2a" */
  readonly route?: string;
  /**
   * Public origin advertised in the Agent Card, when the request's isn't it (for example behind a
   * proxy that rewrites `Host`). The card's interface URL is this origin plus `route`.
   */
  readonly url?: string;
  /** Agent Card fields to set or override. */
  readonly card?: A2aAgentCardOptions;
  /**
   * Longest a blocking `SendMessage` waits for a terminal or interrupted state before returning
   * the working task for the client to poll or subscribe to. Keep it under the host's request
   * timeout.
   * @default 25_000
   */
  readonly maxBlockingMs?: number;
  /**
   * Inbound file parts (`raw` and `url`). Media types outside the policy are refused with
   * `ContentTypeNotSupportedError`. @default 25 MB, any media type
   */
  readonly uploadPolicy?: UploadPolicyInput;
}

export type A2aChannel = Channel;

/** Well-known discovery path (RFC 8615) for an A2A Agent Card. */
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";

const DEFAULT_ROUTE = "/eve/v1/a2a";
const DEFAULT_MAX_BLOCKING_MS = 25_000;

/**
 * Publishes this agent as an A2A server: an Agent Card at `/.well-known/agent-card.json` and a
 * JSON-RPC endpoint at `route`. Each A2A context is one durable eve session bound to the
 * authenticated caller; each task is one turn of it.
 */
export function a2aChannel(input: A2aChannelConfig): A2aChannel {
  if (input?.auth === undefined) {
    throw new Error("a2aChannel requires auth. Use none() for explicit public access.");
  }
  const path = input.route ?? DEFAULT_ROUTE;
  if (!path.startsWith("/") || path === A2A_AGENT_CARD_PATH) {
    throw new Error(`a2aChannel route must be an absolute path other than ${A2A_AGENT_CARD_PATH}.`);
  }
  const maxBlockingMs = input.maxBlockingMs ?? DEFAULT_MAX_BLOCKING_MS;
  if (!Number.isFinite(maxBlockingMs) || maxBlockingMs <= 0) {
    throw new Error("a2aChannel maxBlockingMs must be a positive number of milliseconds.");
  }
  const publicOrigin = input.url === undefined ? undefined : parsePublicOrigin(input.url);
  const uploadPolicy = mergeUploadPolicy(input.uploadPolicy);
  const security: CardSecurity = {
    anonymous: admitsAnonymousCallers(input.auth),
    challenges: declaredAuthChallenges(input.auth),
    oauth: readOAuthResourceOptions(input.auth),
  };

  const card = async (request: Request, args: RouteHandlerArgs) => {
    const failure = validateMcpMetadataRequest(request, "A2A");
    if (failure !== undefined) return failure;
    // Public metadata by design: discovery happens before a client has credentials.
    const body = buildAgentCard({
      described: await args.describe(),
      endpointUrl: new URL(path, publicOrigin ?? new URL(request.url).origin).toString(),
      eveVersion: resolveInstalledPackageInfo().version,
      fileInputModes: fileInputModes(uploadPolicy),
      options: input.card,
      security,
    });
    return Response.json(body, {
      headers: { ...CARD_CORS, "cache-control": "public, max-age=300" },
    });
  };

  const rpc = async (request: Request, args: RouteHandlerArgs) => {
    const failure = validateMcpHttpRequest(request, "A2A");
    if (failure !== undefined) return failure;
    const auth = await routeAuth(request, input.auth);
    if (auth instanceof Response) return auth;
    const createSession = readRouteSessionCreator(args);
    if (createSession === undefined) {
      return Response.json({ error: "A2A requires agent route context." }, { status: 500 });
    }
    const execution = new A2aTaskExecution({
      createSession,
      from: args.from,
      maxBlockingMs,
      resolveSession: args.resolveSession,
      uploadPolicy,
    });
    return await handleA2aJsonRpc(request, sessionAuthFromResult(auth), execution);
  };

  return defineChannel({
    routes: [
      GET(A2A_AGENT_CARD_PATH, card),
      OPTIONS(A2A_AGENT_CARD_PATH, async (request) => {
        const failure = validateMcpMetadataRequest(request, "A2A");
        return failure ?? new Response(null, { headers: CARD_CORS, status: 204 });
      }),
      POST(path, rpc),
    ],
  });
}

const CARD_CORS = {
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-origin": "*",
};

function parsePublicOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`a2aChannel url must be an absolute URL. Received: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`a2aChannel url must be an http(s) URL. Received: ${url}`);
  }
  return parsed.origin;
}

/** The card's file input modes: what the upload policy admits. */
function fileInputModes(policy: UploadPolicy): readonly string[] {
  if (policy === "disabled" || policy.maxBytes === 0) return [];
  return policy.allowedMediaTypes === "*" ? ["*/*"] : policy.allowedMediaTypes;
}
