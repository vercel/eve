import { beforeAll, describe, expect, it } from "vitest";

import {
  createUcpSigner,
  ucpContentDigest,
  ucpSignatureBase,
  ucpSignatureComponents,
} from "#public/commerce/ucp/signing.js";

const AGENT_HEADER = 'profile="https://agent.example/.well-known/ucp"';
const IDEMPOTENCY_KEY = "550e8400-e29b-41d4-a716-446655440000";

const POST_REQUEST = {
  body: '{"line_items":[{"item":{"id":"item_123"},"quantity":1}]}',
  headers: {
    "content-type": "application/json",
    "Idempotency-Key": IDEMPOTENCY_KEY,
    "UCP-Agent": AGENT_HEADER,
  },
  method: "POST",
  url: "https://merchant.example.com/ucp/v1/checkout-sessions",
} as const;

let keyPair: { privateKey: CryptoKey; publicKey: CryptoKey };
let jwk: Record<string, unknown>;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  jwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as Record<string, unknown>;
});

describe("ucpSignatureComponents", () => {
  it("covers the components UCP requires for a POST with a body", () => {
    expect(ucpSignatureComponents(POST_REQUEST)).toEqual([
      "@method",
      "@authority",
      "@path",
      "ucp-agent",
      "idempotency-key",
      "content-digest",
      "content-type",
    ]);
  });

  it("omits body and idempotency components for a bodyless GET", () => {
    expect(
      ucpSignatureComponents({
        headers: { "UCP-Agent": AGENT_HEADER },
        method: "GET",
        url: "https://merchant.example.com/ucp/v1/checkout-sessions/chk_1",
      }),
    ).toEqual(["@method", "@authority", "@path", "ucp-agent"]);
  });

  it("omits content-type for a body sent without one", () => {
    expect(
      ucpSignatureComponents({
        body: "{}",
        headers: { "UCP-Agent": AGENT_HEADER },
        method: "POST",
        url: "https://merchant.example.com/ucp/v1/checkout-sessions",
      }),
    ).toEqual(["@method", "@authority", "@path", "ucp-agent", "content-digest"]);
  });

  it("covers @query only when the URL carries one", () => {
    expect(
      ucpSignatureComponents({
        headers: {},
        method: "GET",
        url: "https://merchant.example.com/ucp/v1/orders/o_1?expand=line_items",
      }),
    ).toContain("@query");
  });
});

describe("ucpSignatureBase", () => {
  it("builds the RFC 9421 base and matching Signature-Input", async () => {
    const contentDigest = await ucpContentDigest(POST_REQUEST.body);
    const { base, signatureInput } = ucpSignatureBase(POST_REQUEST, {
      contentDigest,
      keyId: "platform-2026",
    });

    expect(base).toBe(
      [
        `"@method": POST`,
        `"@authority": merchant.example.com`,
        `"@path": /ucp/v1/checkout-sessions`,
        `"ucp-agent": ${AGENT_HEADER}`,
        `"idempotency-key": ${IDEMPOTENCY_KEY}`,
        `"content-digest": ${contentDigest}`,
        `"content-type": application/json`,
        `"@signature-params": ("@method" "@authority" "@path" "ucp-agent" "idempotency-key" "content-digest" "content-type");keyid="platform-2026"`,
      ].join("\n"),
    );
    expect(signatureInput).toBe(
      `sig1=("@method" "@authority" "@path" "ucp-agent" "idempotency-key" "content-digest" "content-type");keyid="platform-2026"`,
    );
  });

  it("omits alg and includes created only when asked", () => {
    const withCreated = ucpSignatureBase(
      { ...POST_REQUEST, body: undefined, created: 1738617601.9 },
      { keyId: "platform-2026" },
    );
    expect(withCreated.signatureInput).toContain(';created=1738617601;keyid="platform-2026"');
    expect(withCreated.signatureInput).not.toContain("alg=");
  });

  it("lowercases the authority and preserves an explicit port", () => {
    const { base } = ucpSignatureBase(
      { headers: {}, method: "GET", url: "https://Merchant.Example.com:8443/ucp/v1/carts/c_1" },
      { keyId: "k" },
    );
    expect(base).toContain(`"@authority": merchant.example.com:8443`);
  });
});

describe("ucpContentDigest", () => {
  it("formats an RFC 9530 sha-256 digest over the raw bytes", async () => {
    expect(await ucpContentDigest("{}")).toBe(
      "sha-256=:RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=:",
    );
  });

  it("changes when the serialized bytes change, even for equivalent JSON", async () => {
    const compact = await ucpContentDigest('{"a":1}');
    const spaced = await ucpContentDigest('{"a": 1}');
    expect(spaced).not.toBe(compact);
  });
});

describe("createUcpSigner", () => {
  it("produces a signature the public key verifies", async () => {
    const sign = createUcpSigner({ keyId: "platform-2026", privateKey: jwk });
    const headers = await sign(POST_REQUEST);

    expect(headers["Content-Digest"]).toBe(await ucpContentDigest(POST_REQUEST.body));
    expect(headers["Signature-Input"]).toMatch(/^sig1=\(/);
    expect(headers.Signature).toMatch(/^sig1=:.+:$/);

    const { base } = ucpSignatureBase(POST_REQUEST, {
      contentDigest: headers["Content-Digest"],
      keyId: "platform-2026",
    });
    const raw = headers.Signature.slice("sig1=:".length, -1);
    const signature = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));

    // RFC 9421 requires fixed-width r||s, so P-256 signatures are exactly
    // 64 bytes — a DER-encoded signature would be a different length and
    // would fail verification here.
    expect(signature.byteLength).toBe(64);
    await expect(
      crypto.subtle.verify(
        { hash: "SHA-256", name: "ECDSA" },
        keyPair.publicKey,
        signature,
        new TextEncoder().encode(base),
      ),
    ).resolves.toBe(true);
  });

  it("omits Content-Digest for a bodyless request", async () => {
    const sign = createUcpSigner({ keyId: "platform-2026", privateKey: jwk });
    const headers = await sign({
      headers: { "UCP-Agent": AGENT_HEADER },
      method: "GET",
      url: "https://merchant.example.com/ucp/v1/checkout-sessions/chk_1",
    });
    expect(headers["Content-Digest"]).toBeUndefined();
    expect(headers["Signature-Input"]).not.toContain("content-digest");
  });

  it("honors a custom signature label", async () => {
    const sign = createUcpSigner({ keyId: "platform-2026", privateKey: jwk });
    const headers = await sign({ ...POST_REQUEST, label: "ucp1" });
    expect(headers["Signature-Input"]).toMatch(/^ucp1=\(/);
    expect(headers.Signature).toMatch(/^ucp1=:/);
  });

  it("signs with a PKCS#8 PEM key", async () => {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    let base64 = "";
    for (const byte of pkcs8) {
      base64 += String.fromCharCode(byte);
    }
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(base64)}\n-----END PRIVATE KEY-----\n`;

    const sign = createUcpSigner({ keyId: "platform-2026", privateKey: pem });
    await expect(sign(POST_REQUEST)).resolves.toHaveProperty("Signature");
  });

  it("reports an undecodable key against its keyId", async () => {
    const sign = createUcpSigner({ keyId: "platform-2026", privateKey: "not-a-pem" });
    await expect(sign(POST_REQUEST)).rejects.toThrow(/platform-2026/);
  });

  it("rejects an unsupported JWK curve", () => {
    expect(() =>
      createUcpSigner({ keyId: "platform-2026", privateKey: { crv: "P-521", kty: "EC" } }),
    ).toThrow(/unsupported curve "P-521"/);
  });
});
