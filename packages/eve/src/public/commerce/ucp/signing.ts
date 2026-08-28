/**
 * HTTP Message Signatures (RFC 9421) and content digests (RFC 9530) as
 * UCP profiles them.
 *
 * UCP verifiers resolve the signing key by matching the `keyid`
 * parameter against a `kid` in the signer's profile `signing_keys[]`, so
 * `keyId` here must be the `kid` published in the agent profile named by
 * the `UCP-Agent` header.
 */

/** Signature algorithms UCP allows. P-256 verification is mandatory; P-384 is optional. */
export type UcpSignatureAlgorithm = "ES256" | "ES384";

/**
 * The JWK fields an EC private key needs, as published alongside its
 * public counterpart in a profile's `signing_keys`.
 */
export interface UcpJsonWebKey {
  readonly kty?: string;
  readonly crv?: string;
  readonly d?: string;
  readonly x?: string;
  readonly y?: string;
  readonly alg?: string;
  readonly use?: string;
}

/** Private key material used to sign outgoing UCP requests. */
export interface UcpSigningKey {
  /** `kid` of the matching public key in the agent profile's `signing_keys`. */
  readonly keyId: string;
  /**
   * The private key, as a PKCS#8 PEM string or a JWK.
   *
   * A JWK's `crv` determines the algorithm; for PEM, set
   * {@link algorithm} (it defaults to `ES256`).
   */
  readonly privateKey: string | UcpJsonWebKey;
  readonly algorithm?: UcpSignatureAlgorithm;
}

/** The request a signer covers. `headers` must be the ones actually sent. */
export interface UcpSignatureRequest {
  readonly method: string;
  /** Absolute request URL, including the query string. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized request body, absent for requests that send none. */
  readonly body?: string;
  /** Signature label. Defaults to `sig1`. */
  readonly label?: string;
  /**
   * `created` signature parameter, in seconds since the Unix epoch.
   *
   * Optional in UCP: replay protection lives at the business layer via
   * `Idempotency-Key`, not signature freshness. Omitting it keeps the
   * signature reproducible across retries of the same request.
   */
  readonly created?: number;
}

/** Headers a signer produces, ready to merge into the outgoing request. */
export interface UcpSignatureHeaders {
  /** Present only when the request carries a body. */
  readonly "Content-Digest"?: string;
  readonly "Signature-Input": string;
  readonly Signature: string;
}

/** Signs one request. Returned by {@link createUcpSigner}. */
export type UcpSigner = (request: UcpSignatureRequest) => Promise<UcpSignatureHeaders>;

const DEFAULT_LABEL = "sig1";

const CURVES: Record<UcpSignatureAlgorithm, { namedCurve: string; hash: string }> = {
  ES256: { namedCurve: "P-256", hash: "SHA-256" },
  ES384: { namedCurve: "P-384", hash: "SHA-384" },
};

const JWK_CURVE_ALGORITHMS: Record<string, UcpSignatureAlgorithm> = {
  "P-256": "ES256",
  "P-384": "ES384",
};

/**
 * The components UCP requires a REST request signature to cover, in the
 * order they are emitted.
 *
 * `@query` is covered only when the URL has one, `ucp-agent` and
 * `idempotency-key` only when those headers are sent, and
 * `content-digest`/`content-type` only when there is a body — so the base
 * is always built from what the request actually contains.
 */
export function ucpSignatureComponents(request: UcpSignatureRequest): readonly string[] {
  const url = new URL(request.url);
  const components = ["@method", "@authority", "@path"];
  if (url.search.length > 0) {
    components.push("@query");
  }
  if (findHeader(request.headers, "ucp-agent") !== undefined) {
    components.push("ucp-agent");
  }
  if (findHeader(request.headers, "idempotency-key") !== undefined) {
    components.push("idempotency-key");
  }
  if (request.body !== undefined) {
    components.push("content-digest");
    // Only cover `content-type` when the request actually sends it, so the
    // base never claims a component the verifier will not see.
    if (findHeader(request.headers, "content-type") !== undefined) {
      components.push("content-type");
    }
  }
  return components;
}

/**
 * Builds the RFC 9421 signature base and the matching `Signature-Input`
 * value.
 *
 * Exported because the base is the contract: when a merchant reports
 * `signature_invalid`, comparing this string against what the verifier
 * reconstructed is the fastest way to find the disagreement.
 */
export function ucpSignatureBase(
  request: UcpSignatureRequest,
  options: { readonly keyId: string; readonly contentDigest?: string },
): { readonly base: string; readonly signatureInput: string } {
  const url = new URL(request.url);
  const components = ucpSignatureComponents(request);
  const lines: string[] = [];

  for (const component of components) {
    lines.push(`"${component}": ${componentValue(component, request, url, options.contentDigest)}`);
  }

  const label = request.label ?? DEFAULT_LABEL;
  const serializedComponents = components.map((component) => `"${component}"`).join(" ");
  const parameters =
    request.created === undefined
      ? `;keyid="${options.keyId}"`
      : `;created=${Math.floor(request.created)};keyid="${options.keyId}"`;
  const signatureParams = `(${serializedComponents})${parameters}`;

  lines.push(`"@signature-params": ${signatureParams}`);

  return { base: lines.join("\n"), signatureInput: `${label}=${signatureParams}` };
}

/**
 * Computes an RFC 9530 `Content-Digest` header value over the raw body
 * bytes.
 *
 * The digest covers the exact bytes sent. Nothing between the signer and
 * `fetch` may re-serialize the JSON, or the digest — and the signature
 * over it — stops matching.
 */
export async function ucpContentDigest(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha-256=:${toBase64(new Uint8Array(digest))}:`;
}

/**
 * Creates a signer bound to one key, importing the key material once and
 * reusing it across requests.
 */
export function createUcpSigner(key: UcpSigningKey): UcpSigner {
  const algorithm = resolveAlgorithm(key);
  const curve = CURVES[algorithm];
  let imported: Promise<CryptoKey> | undefined;
  const getKey = () => (imported ??= importPrivateKey(key, curve.namedCurve));

  return async (request) => {
    const contentDigest =
      request.body === undefined ? undefined : await ucpContentDigest(request.body);
    const { base, signatureInput } = ucpSignatureBase(request, {
      contentDigest,
      keyId: key.keyId,
    });

    // WebCrypto's ECDSA output is already the fixed-width r||s encoding
    // RFC 9421 mandates, not the ASN.1/DER that most server-side crypto
    // libraries emit by default.
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: curve.hash },
      await getKey(),
      new TextEncoder().encode(base),
    );

    const label = request.label ?? DEFAULT_LABEL;
    const headers: {
      "Content-Digest"?: string;
      "Signature-Input": string;
      Signature: string;
    } = {
      Signature: `${label}=:${toBase64(new Uint8Array(signature))}:`,
      "Signature-Input": signatureInput,
    };
    if (contentDigest !== undefined) {
      headers["Content-Digest"] = contentDigest;
    }
    return headers;
  };
}

function resolveAlgorithm(key: UcpSigningKey): UcpSignatureAlgorithm {
  if (key.algorithm !== undefined) {
    return key.algorithm;
  }
  if (typeof key.privateKey !== "string" && typeof key.privateKey.crv === "string") {
    const derived = JWK_CURVE_ALGORITHMS[key.privateKey.crv];
    if (derived === undefined) {
      throw new Error(
        `UCP signing key "${key.keyId}" uses unsupported curve "${key.privateKey.crv}". Use P-256 (ES256) or P-384 (ES384).`,
      );
    }
    return derived;
  }
  return "ES256";
}

async function importPrivateKey(key: UcpSigningKey, namedCurve: string): Promise<CryptoKey> {
  const algorithm = { name: "ECDSA", namedCurve } as const;
  if (typeof key.privateKey !== "string") {
    return crypto.subtle.importKey("jwk", key.privateKey, algorithm, false, ["sign"]);
  }
  return crypto.subtle.importKey(
    "pkcs8",
    decodePkcs8Pem(key.privateKey, key.keyId),
    algorithm,
    false,
    ["sign"],
  );
}

function decodePkcs8Pem(pem: string, keyId: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (body.length === 0) {
    throw new Error(
      `UCP signing key "${keyId}" is empty. Provide a PKCS#8 PEM private key ("-----BEGIN PRIVATE KEY-----") or a JWK.`,
    );
  }
  try {
    return fromBase64(body);
  } catch {
    throw new Error(
      `UCP signing key "${keyId}" could not be decoded. Provide a PKCS#8 PEM private key ("-----BEGIN PRIVATE KEY-----") or a JWK.`,
    );
  }
}

function componentValue(
  component: string,
  request: UcpSignatureRequest,
  url: URL,
  contentDigest: string | undefined,
): string {
  switch (component) {
    case "@method":
      return request.method.toUpperCase();
    case "@authority":
      return url.host.toLowerCase();
    case "@path":
      return url.pathname;
    case "@query":
      return url.search;
    case "content-digest":
      return contentDigest ?? findHeader(request.headers, "content-digest") ?? "";
    default:
      return findHeader(request.headers, component) ?? "";
  }
}

/** Case-insensitive header lookup, since header names are not case-sensitive. */
function findHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value.trim();
    }
  }
  return undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
