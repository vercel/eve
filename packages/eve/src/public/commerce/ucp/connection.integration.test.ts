import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  defineUcpConnection,
  type UcpConnectionDefinition,
} from "#public/commerce/ucp/connection.js";
import { resolveUcpCheckoutHandoff } from "#public/commerce/ucp/handoff.js";
import { ucpSignatureBase } from "#public/commerce/ucp/signing.js";
import type { OpenAPIConnectionDefinition } from "#public/definitions/connections/openapi.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/**
 * Trimmed copy of the canonical UCP shopping REST contract: the two
 * operations under test, with the header parameters the published
 * document actually declares — including the three it marks required.
 */
const UCP_SPEC: Record<string, unknown> = {
  components: {
    parameters: {
      authorization: { in: "header", name: "Authorization", schema: { type: "string" } },
      checkout_session_id_path: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      content_digest: { in: "header", name: "Content-Digest", schema: { type: "string" } },
      idempotency_key: {
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { format: "uuid", type: "string" },
      },
      request_id: {
        in: "header",
        name: "Request-Id",
        required: true,
        schema: { format: "uuid", type: "string" },
      },
      signature: { in: "header", name: "Signature", schema: { type: "string" } },
      signature_input: { in: "header", name: "Signature-Input", schema: { type: "string" } },
      ucp_agent: { in: "header", name: "UCP-Agent", required: true, schema: { type: "string" } },
    },
  },
  info: { title: "UCP Shopping Service", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/checkout-sessions": {
      post: {
        operationId: "create_checkout",
        parameters: [
          { $ref: "#/components/parameters/authorization" },
          { $ref: "#/components/parameters/signature" },
          { $ref: "#/components/parameters/signature_input" },
          { $ref: "#/components/parameters/content_digest" },
          { $ref: "#/components/parameters/idempotency_key" },
          { $ref: "#/components/parameters/request_id" },
          { $ref: "#/components/parameters/ucp_agent" },
        ],
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
          required: true,
        },
        responses: { "201": { description: "created" } },
        summary: "Create a checkout session",
      },
    },
    "/checkout-sessions/{id}": {
      get: {
        operationId: "get_checkout",
        parameters: [
          { $ref: "#/components/parameters/checkout_session_id_path" },
          { $ref: "#/components/parameters/authorization" },
          { $ref: "#/components/parameters/request_id" },
          { $ref: "#/components/parameters/ucp_agent" },
        ],
        responses: { "200": { description: "ok" } },
        summary: "Get a checkout session",
      },
    },
  },
};

const CHECKOUT_RESPONSE = {
  continue_url: "https://acme.example.com/checkout/chk_1",
  currency: "USD",
  id: "chk_1",
  line_items: [],
  messages: [{ code: "eligibility_invalid", severity: "requires_buyer_input", type: "error" }],
  status: "requires_escalation",
  ucp: { capabilities: {}, version: "2026-04-08" },
};

let keyPair: { privateKey: CryptoKey; publicKey: CryptoKey };
let jwk: Record<string, unknown>;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  jwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as Record<string, unknown>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mirrors what `resolveConnectionDefinition` hands the runtime client. */
function resolve(definition: OpenAPIConnectionDefinition): ResolvedConnectionDefinition {
  const resolved: {
    -readonly [K in keyof ResolvedConnectionDefinition]: ResolvedConnectionDefinition[K];
  } = {
    connectionName: "acme",
    description: definition.description,
    logicalPath: "connections/acme.ts",
    protocol: "openapi",
    sourceId: "connections/acme",
    sourceKind: "module",
    spec: UCP_SPEC,
    url: definition.baseUrl ?? "",
  };
  if (definition.auth !== undefined) {
    resolved.authorization = definition.auth as ResolvedConnectionDefinition["authorization"];
  }
  if (definition.headers !== undefined) {
    resolved.headers = definition.headers;
  }
  if (definition.toolCall !== undefined) {
    resolved.toolCall = definition.toolCall;
  }
  if (definition.prepareRequest !== undefined) {
    resolved.prepareRequest = definition.prepareRequest;
  }
  return resolved;
}

function client(options: { readonly signed: boolean }): OpenApiConnectionClient {
  const definition: UcpConnectionDefinition = {
    agent: { profile: "https://agent.example/.well-known/ucp" },
    auth: { getToken: async () => ({ token: "merchant-token" }) },
    description: "Acme storefront.",
    endpoint: "https://acme.example.com/ucp/v1",
  };
  const signing = { keyId: "platform-2026", privateKey: jwk };
  return new OpenApiConnectionClient(
    resolve(defineUcpConnection(options.signed ? { ...definition, signing } : definition)),
  );
}

function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: URL, _init: RequestInit) =>
      new Response(JSON.stringify(CHECKOUT_RESPONSE), {
        headers: { "content-type": "application/json" },
        status: 201,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function withContext<T>(run: () => Promise<T>): Promise<T> {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  });
  return contextStorage.run(ctx, run);
}

function sentHeaders(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("defineUcpConnection over the OpenAPI connection client", () => {
  it("leaves the model only the operation's own inputs", async () => {
    const metadata = await client({ signed: true }).getToolMetadata();

    expect(metadata.find((item) => item.name === "create_checkout")?.inputSchema).toEqual({
      properties: { body: { type: "object" } },
      required: ["body"],
      type: "object",
    });
    expect(metadata.find((item) => item.name === "get_checkout")?.inputSchema).toEqual({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    });
  });

  it("sends the agent profile, retry-safe ids, and a verifiable signature", async () => {
    const fetchMock = stubFetch();

    await withContext(() =>
      client({ signed: true }).executeTool(
        "create_checkout",
        { body: { line_items: [{ item: { id: "item_123" }, quantity: 1 }] } },
        { callId: "call-1" },
      ),
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = sentHeaders(init);

    expect(String(url)).toBe("https://acme.example.com/ucp/v1/checkout-sessions");
    expect(init.method).toBe("POST");
    expect(headers["UCP-Agent"]).toBe('profile="https://agent.example/.well-known/ucp"');
    expect(headers.Authorization).toBe("Bearer merchant-token");
    expect(headers["Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["Idempotency-Key"]).not.toBe(headers["Request-Id"]);

    const base = ucpSignatureBase(
      {
        body: init.body as string,
        headers,
        method: "POST",
        url: String(url),
      },
      { contentDigest: headers["Content-Digest"], keyId: "platform-2026" },
    ).base;
    expect(headers["Signature-Input"]).toBe(
      ucpSignatureBase(
        { body: init.body as string, headers, method: "POST", url: String(url) },
        { keyId: "platform-2026" },
      ).signatureInput,
    );

    const signature = headers.Signature ?? "";
    const raw = signature.slice("sig1=:".length, -1);
    await expect(
      crypto.subtle.verify(
        { hash: "SHA-256", name: "ECDSA" },
        keyPair.publicKey,
        Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)),
        new TextEncoder().encode(base),
      ),
    ).resolves.toBe(true);
  });

  it("reuses the idempotency key when the same call is replayed", async () => {
    const fetchMock = stubFetch();
    const connection = client({ signed: false });

    const run = (callId: string) =>
      withContext(() =>
        connection.executeTool("create_checkout", { body: { line_items: [] } }, { callId }),
      );

    await run("call-1");
    await run("call-1");
    await run("call-2");

    const keys = fetchMock.mock.calls.map((call) => sentHeaders(call[1])["Idempotency-Key"]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("omits the idempotency key on a read", async () => {
    const fetchMock = stubFetch();

    await withContext(() =>
      client({ signed: false }).executeTool("get_checkout", { id: "chk_1" }, { callId: "call-1" }),
    );

    const headers = sentHeaders(fetchMock.mock.calls[0]![1]);
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(headers["Request-Id"]).toBeDefined();
    expect(headers["UCP-Agent"]).toBeDefined();
  });

  it("ignores protocol headers a model tries to supply", async () => {
    const fetchMock = stubFetch();

    await withContext(() =>
      client({ signed: false }).executeTool(
        "create_checkout",
        {
          Authorization: "Bearer stolen",
          body: { line_items: [] },
          "Idempotency-Key": "00000000-0000-4000-8000-000000000000",
          "UCP-Agent": 'profile="https://attacker.example/p.json"',
        },
        { callId: "call-1" },
      ),
    );

    const headers = sentHeaders(fetchMock.mock.calls[0]![1]);
    expect(headers.Authorization).toBe("Bearer merchant-token");
    expect(headers["UCP-Agent"]).toBe('profile="https://agent.example/.well-known/ucp"');
    expect(headers["Idempotency-Key"]).not.toBe("00000000-0000-4000-8000-000000000000");
  });

  it("sends no signature headers when the connection is unsigned", async () => {
    const fetchMock = stubFetch();

    await withContext(() =>
      client({ signed: false }).executeTool(
        "create_checkout",
        { body: { line_items: [] } },
        { callId: "call-1" },
      ),
    );

    const headers = sentHeaders(fetchMock.mock.calls[0]![1]);
    expect(headers.Signature).toBeUndefined();
    expect(headers["Signature-Input"]).toBeUndefined();
    expect(headers["Content-Digest"]).toBeUndefined();
  });

  it("resolves the tool result straight into a handoff", async () => {
    stubFetch();

    const result = await withContext(() =>
      client({ signed: false }).executeTool(
        "create_checkout",
        { body: { line_items: [] } },
        { callId: "call-1" },
      ),
    );

    expect(resolveUcpCheckoutHandoff(result)).toMatchObject({
      checkoutId: "chk_1",
      kind: "continue_url",
      reason: "requires_buyer_input",
      url: "https://acme.example.com/checkout/chk_1",
    });
  });
});
