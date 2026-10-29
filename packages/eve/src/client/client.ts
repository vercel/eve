import {
  EVE_COMMANDS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
  EVE_SESSION_ROUTE_PATH,
} from "#protocol/routes.js";
import {
  type ChannelCommandInfo,
  ChannelCommandListSchema,
  type ChannelCommandResult,
  ChannelCommandResultSchema,
  CommandResponseError,
} from "#client/commands.js";
import type { z } from "#compiled/zod/index.js";
import { AgentInfoResponseError } from "#client/agent-info-error.js";
import { HealthResponseError } from "#client/health-response-error.js";
import { HealthResultSchema } from "#client/health-schema.js";
import { encodeBasicCredentials } from "#internal/http/basic-auth.js";
import {
  AgentInfoResultSchema,
  describeAgentInfoVersionMismatch,
} from "#client/agent-info-schema.js";
import { ClientError, createClientError } from "#client/client-error.js";
import { ClientSessions } from "#client/sessions.js";
import { createClientUrl } from "#client/url.js";
import type {
  AgentInfoResult,
  ClientAuth,
  ClientOptions,
  ClientRedirectPolicy,
  HeadersValue,
  HealthResult,
  TokenValue,
} from "#client/types.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";

/**
 * HTTP client for talking to a deployed eve agent.
 *
 * A single client is bound to one base URL and auth configuration. Its
 * `sessions` collection can create or attach many independent fixed session
 * handles.
 */
export class Client {
  readonly #auth: ClientAuth | undefined;
  readonly #headers: HeadersValue | undefined;
  readonly #baseUrl: string;
  readonly #redirect: ClientRedirectPolicy;
  /** Explicit create/attach surface for ID-addressed sessions. */
  readonly sessions: ClientSessions;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#auth = options.auth;
    this.#headers = options.headers;
    this.#redirect = options.redirect ?? "error";
    this.sessions = new ClientSessions({
      baseUrl: this.#baseUrl,
      redirect: this.#redirect,
      resolveHeaders: (perRequest) => this.#resolveHeaders(perRequest),
    });
  }

  /**
   * Checks the health of the eve agent server.
   *
   * @throws {ClientError} If the server returns a non-successful status.
   */
  async health(): Promise<HealthResult> {
    const url = createClientUrl(this.#baseUrl, EVE_HEALTH_ROUTE_PATH);
    const headers = await this.#resolveHeaders();
    const response = await fetch(url, withRedirectPolicy({ headers }, this.#redirect));

    if (!response.ok) {
      const body = await response.text();
      throw new ClientError(response.status, body, response.headers);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new HealthResponseError();
    }

    const result = HealthResultSchema.safeParse(payload);
    if (!result.success) {
      throw new HealthResponseError(
        result.error.issues.slice(0, 5).map((issue) => {
          const path = issue.path.join(".");
          return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
        }),
      );
    }
    return result.data;
  }

  /**
   * Fetches the agent inspection payload from `GET /eve/v1/info`.
   *
   * The dev TUI uses it to render its startup header. Remote deployments
   * require whatever auth the info route accepts, which defaults to Vercel
   * OIDC outside local development.
   *
   * @throws {ClientError} If the server returns a non-successful status.
   * @throws {AgentInfoResponseError} If an authorized response carries a body
   * that is not a recognized agent-info payload (not JSON, another agent-info
   * version, or a mismatched shape). Unknown fields are ignored and unknown
   * enum values read as `"unrecognized"`. Inspection is best-effort: a working
   * connection does not depend on this route, so connection probes treat this
   * distinctly from a failed request.
   */
  async info(options: { readonly signal?: AbortSignal } = {}): Promise<AgentInfoResult> {
    const response = await this.fetch(EVE_INFO_ROUTE_PATH, options);

    if (!response.ok) {
      const body = await response.text();
      throw new ClientError(response.status, body, response.headers);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AgentInfoResponseError();
    }

    const versionMismatch = describeAgentInfoVersionMismatch(payload);
    if (versionMismatch !== undefined) throw new AgentInfoResponseError([versionMismatch]);

    const result = AgentInfoResultSchema.safeParse(payload);
    if (!result.success) {
      throw new AgentInfoResponseError(
        result.error.issues.slice(0, 5).map((issue) => {
          const path = issue.path.join(".");
          return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
        }),
      );
    }

    return result.data;
  }

  /**
   * Lists the slash commands the eve channel offers from `GET /eve/v1/commands`.
   *
   * @throws {ClientError} If the server returns a non-successful status, including 404 from a
   * server that predates channel commands.
   * @throws {CommandResponseError} If a successful response's body is not a command list.
   */
  async commands(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly ChannelCommandInfo[]> {
    const payload = await this.#readCommandJson(EVE_COMMANDS_ROUTE_PATH, options);
    return parseCommandResponse(ChannelCommandListSchema, payload).commands;
  }

  /**
   * Runs one eve channel slash command: inside `sessionId` through
   * `POST /eve/v1/session/:sessionId/commands/:name`, or without a session through
   * `POST /eve/v1/commands/:name`.
   *
   * @throws {ClientError} If the command is unknown, needs a session it didn't get, the caller is
   * unauthorized, the session can't take it, or it fails.
   * @throws {CommandResponseError} If a successful response's body is not a command result.
   */
  async runCommand(
    name: string,
    options: {
      readonly argument?: string;
      readonly sessionId?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ChannelCommandResult> {
    const command = encodeURIComponent(name);
    const path =
      options.sessionId === undefined
        ? `${EVE_COMMANDS_ROUTE_PATH}/${command}`
        : `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(options.sessionId)}/commands/${command}`;
    const payload = await this.#readCommandJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argument: options.argument ?? "" }),
      signal: options.signal,
    });
    const { message, send, controls } = parseCommandResponse(ChannelCommandResultSchema, payload);
    const result: { message?: string; send?: string; controls?: typeof controls } = {};
    if (message !== undefined) result.message = message;
    if (send !== undefined) result.send = send;
    if (controls !== undefined) result.controls = controls;
    return result;
  }

  /**
   * Performs an authenticated fetch against a path on this eve target.
   *
   * This is the raw escape hatch for framework-owned routes (for example
   * channel ingress or dev-only schedule dispatch) while preserving the same
   * auth/header cascade used by {@link health}, {@link info}, and sessions.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = createClientUrl(this.#baseUrl, path);
    const headers = await this.#resolveHeaders(headersInitToRecord(init.headers));
    return await fetch(url, withRedirectPolicy({ ...init, headers }, this.#redirect));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async #readCommandJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetch(path, init);
    if (!response.ok) {
      throw createClientError(response.status, await response.text(), response.headers);
    }
    try {
      return await response.json();
    } catch {
      throw new CommandResponseError();
    }
  }

  async #resolveHeaders(perRequest?: Readonly<Record<string, string>>): Promise<Headers> {
    const headers = new Headers();
    // Start both dynamic providers together so shared credential state is
    // captured once per request, before either provider can be replaced.
    const [baseHeaders, authHeaders] = await Promise.all([
      resolveHeadersValue(this.#headers),
      this.#resolveAuthHeaders(),
    ]);

    for (const [key, value] of Object.entries(baseHeaders)) {
      headers.set(key, value);
    }

    for (const [key, value] of Object.entries(authHeaders)) {
      headers.set(key, value);
    }

    if (perRequest) {
      for (const [key, value] of Object.entries(perRequest)) {
        headers.set(key, value);
      }
    }

    return headers;
  }

  async #resolveAuthHeaders(): Promise<Readonly<Record<string, string>>> {
    const auth = this.#auth;
    if (!auth) return {};

    if ("vercelOidc" in auth) {
      // One credential, two headers: the bearer the route reads and the
      // trusted-OIDC header Vercel Deployment Protection accepts. Resolved
      // once; the client-side mirror of the server `vercelOidc()` channel.
      const token = (await resolveTokenValue(auth.vercelOidc.token)).trim();
      if (token.length === 0) return {};
      return {
        authorization: `Bearer ${token}`,
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: token,
      };
    }

    if ("bearer" in auth) {
      // Skip the header entirely on an empty token rather than emitting a
      // malformed `Bearer ` value the server has to reject. The dev client's
      // OIDC resolver returns "" when no token is available locally; the
      // request then follows the framework channel's local-dev fallback.
      const token = (await resolveTokenValue(auth.bearer)).trim();
      return token.length === 0 ? {} : { authorization: `Bearer ${token}` };
    }

    if ("basic" in auth) {
      const password = await resolveTokenValue(auth.basic.password);
      return {
        authorization: `Basic ${encodeBasicCredentials(auth.basic.username, password)}`,
      };
    }

    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCommandResponse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  throw new CommandResponseError(
    result.error.issues.slice(0, 5).map((issue) => {
      const path = issue.path.join(".");
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    }),
  );
}

async function resolveTokenValue(value: TokenValue): Promise<string> {
  return typeof value === "function" ? value() : value;
}

async function resolveHeadersValue(
  value: HeadersValue | undefined,
): Promise<Readonly<Record<string, string>>> {
  if (value === undefined) {
    return {};
  }

  return typeof value === "function" ? await value() : value;
}

function headersInitToRecord(
  headers: RequestInit["headers"] | undefined,
): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function withRedirectPolicy(init: RequestInit, redirect: ClientRedirectPolicy): RequestInit {
  return { ...init, redirect };
}
