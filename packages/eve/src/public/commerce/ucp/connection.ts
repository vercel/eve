/**
 * The generic UCP connection preset.
 *
 * A UCP shopping service is an ordinary OpenAPI service, so this builds
 * an {@link OpenAPIConnectionDefinition} rather than introducing a new
 * connection protocol. What it adds is the protocol plumbing the
 * canonical contract leaves to the caller: the published REST spec types
 * `UCP-Agent`, `Idempotency-Key`, `Request-Id`, `Authorization`,
 * `Signature`, `Signature-Input`, and `Content-Digest` as ordinary header
 * parameters, so without a preset every one of them lands in the
 * model-facing input schema and the model is asked to invent identity,
 * credentials, and signatures. Here they are application-owned: hidden
 * from the model and filled in from the connection's configuration.
 */

import type { Approval } from "#public/definitions/approval.js";
import type {
  ConnectionRequestPreparation,
  OpenAPIConnectionDefinition,
  OpenAPISpecSource,
} from "#public/definitions/connections/openapi.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import type {
  ProvidedArgumentsDefinition,
  ProvidedArgumentValue,
} from "#public/definitions/connections/tool-call.js";
import type {
  ConnectionAuthDefinition,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#shared/connection-types.js";
import {
  deriveUcpRequestUuid,
  ucpAgentHeaderValue,
  ucpShoppingRestSpecUrl,
  UCP_VERSION,
  type UcpAgentMetadata,
} from "#public/commerce/ucp/protocol.js";
import { createUcpSigner, type UcpSigningKey } from "#public/commerce/ucp/signing.js";

/**
 * Header parameters the preset owns.
 *
 * Each is suppressed from the model-facing schema by resolving to
 * `null` — eve strips a provided argument from the schema and, because
 * `null` parameters are skipped when the request is built, writes no
 * header for it. Both the canonical and lower-cased spellings are
 * suppressed so the preset stays correct against merchant-published
 * specs that differ in header casing.
 */
const MANAGED_HEADER_PARAMETERS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Content-Digest",
  "Content-Type",
  "Idempotency-Key",
  "Request-Id",
  "Signature",
  "Signature-Input",
  "UCP-Agent",
  "User-Agent",
  "X-API-Key",
] as const;

/** Methods that carry a retry-safe `Idempotency-Key`. */
const IDEMPOTENT_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export interface UcpConnectionDefinition {
  /**
   * The shopping service base URL, taken from the merchant's
   * `/.well-known/ucp` profile at
   * `services["dev.ucp.shopping"][transport="rest"].endpoint`.
   *
   * Required: the canonical contract declares its server as an
   * `{endpoint}` template variable with a placeholder default, so there
   * is nothing usable to fall back to.
   */
  readonly endpoint: string;
  /** Human-readable summary used in the system prompt and `connection_search`. */
  readonly description: string;
  /** Identity this agent advertises on every request. */
  readonly agent: UcpAgentMetadata;
  /** UCP version whose REST contract to load. Defaults to {@link UCP_VERSION}. */
  readonly version?: string;
  /**
   * Override the OpenAPI document. Defaults to the canonical UCP
   * shopping REST contract for `version`.
   *
   * Point this at the merchant's own `schema` URL when they publish an
   * extended contract, or at a pinned inline document.
   */
  readonly spec?: OpenAPISpecSource;
  /**
   * Credential for the merchant's API (API key, OAuth, pre-provisioned
   * token). Sent as `Authorization: Bearer <token>`.
   *
   * UCP allows API keys, OAuth, and mTLS as alternatives to message
   * signatures, so a connection may authenticate with `auth` alone.
   */
  readonly auth?: ConnectionAuthDefinition;
  /** Approval gate for the connection's tool calls. */
  readonly approval?: Approval;
  /** Extra headers merged after the preset's own. */
  readonly headers?: HeadersDefinition;
  /** Operation filter, keyed on `operationId` (e.g. `"create_checkout"`). */
  readonly operations?: ToolFilterDefinition;
  /**
   * Application-owned operation arguments, hidden from the model and
   * resolved per call.
   *
   * Applied after the preset's own, so an entry here can re-expose or
   * override a managed header parameter.
   */
  readonly providedArguments?: ProvidedArgumentsDefinition;
  /**
   * Sign every request with HTTP Message Signatures (RFC 9421).
   *
   * The key's `keyId` must match a `kid` in the `signing_keys` of the
   * profile named by {@link agent}, since that is how the merchant
   * resolves the verification key. Omit to authenticate with `auth`
   * alone; merchants that require signatures reject unsigned requests
   * with `signature_missing`.
   */
  readonly signing?: UcpSigningKey;
}

/**
 * Defines a connection to a UCP shopping service.
 *
 * The connection name comes from the filename, as with every eve
 * connection: `agent/connections/acme.ts` registers as `acme` and its
 * operations become `acme__create_checkout` and friends.
 *
 * @example
 * ```ts
 * // agent/connections/acme.ts
 * import { defineUcpConnection } from "eve/commerce/ucp";
 *
 * export default defineUcpConnection({
 *   endpoint: "https://acme.example.com/ucp/v1",
 *   description: "Acme storefront: carts, checkout, and orders.",
 *   agent: { profile: "https://my-agent.example.com/.well-known/ucp" },
 *   auth: { getToken: async () => ({ token: process.env.ACME_TOKEN! }) },
 *   signing: {
 *     keyId: "platform-2026",
 *     privateKey: process.env.UCP_SIGNING_KEY!,
 *   },
 * });
 * ```
 */
export function defineUcpConnection(
  definition: UcpConnectionDefinition,
): OpenAPIConnectionDefinition {
  const version = definition.version ?? UCP_VERSION;
  const agentHeader = ucpAgentHeaderValue(definition.agent);
  const sign = definition.signing === undefined ? undefined : createUcpSigner(definition.signing);

  const openapi: {
    -readonly [K in keyof OpenAPIConnectionDefinition]: OpenAPIConnectionDefinition[K];
  } = {
    baseUrl: definition.endpoint,
    description: definition.description,
    headers: mergeHeaders({ "UCP-Agent": agentHeader }, definition.headers),
    prepareRequest: (request) => prepareUcpRequest(request, sign),
    spec: definition.spec ?? ucpShoppingRestSpecUrl(version),
    toolCall: {
      providedArguments: {
        ...suppressedHeaderParameters(),
        ...definition.providedArguments,
      },
    },
  };

  if (definition.auth !== undefined) {
    openapi.auth = definition.auth;
  }
  if (definition.approval !== undefined) {
    openapi.approval = definition.approval;
  }
  if (definition.operations !== undefined) {
    openapi.operations = definition.operations;
  }

  return defineOpenAPIConnection(openapi);
}

/**
 * Adds the retry-safe request identifiers, then signs.
 *
 * Order matters: `Idempotency-Key` is a covered component of the
 * signature base, so it has to exist before the signature is computed.
 */
async function prepareUcpRequest(
  request: ConnectionRequestPreparation,
  sign: ReturnType<typeof createUcpSigner> | undefined,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Request-Id": await deriveUcpRequestUuid(`request:${request.callId}:${request.toolName}`),
  };
  if (IDEMPOTENT_METHODS.has(request.method)) {
    headers["Idempotency-Key"] = await deriveUcpRequestUuid(
      `idempotency:${request.callId}:${request.toolName}`,
    );
  }

  if (sign === undefined) {
    return headers;
  }

  const signed = await sign({
    body: request.body,
    headers: { ...request.headers, ...headers },
    method: request.method,
    url: request.url,
  });
  return { ...headers, ...signed };
}

function suppressedHeaderParameters(): ProvidedArgumentsDefinition {
  const suppressed: Record<string, ProvidedArgumentValue> = {};
  for (const name of MANAGED_HEADER_PARAMETERS) {
    suppressed[name] = null;
    suppressed[name.toLowerCase()] = null;
  }
  return suppressed;
}

function mergeHeaders(
  preset: Readonly<Record<string, string>>,
  authored: HeadersDefinition | undefined,
): HeadersDefinition {
  if (authored === undefined) {
    return preset;
  }
  if (typeof authored === "function") {
    return async (ctx) => ({ ...preset, ...(await authored(ctx)) });
  }
  return { ...preset, ...authored };
}
