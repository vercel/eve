import { generateKeyPairSync, type JsonWebKey } from "node:crypto";

export interface BaselayerConfig {
  apiKey: string;
  principalRef: string;
  allowedOrigins: string[];
}

/** Server-side only. The configured principal belongs to this single-user demo. */
export function baselayerConfig(
  env: Record<string, string | undefined> = process.env,
): BaselayerConfig {
  const apiKey = env.BASELAYER_API_KEY?.trim();
  const principalRef = env.BASELAYER_PRINCIPAL_REF?.trim();
  const allowedOrigins = env.BASELAYER_ALLOWED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || !principalRef || !allowedOrigins?.length) {
    throw new Error(
      "Set BASELAYER_API_KEY, BASELAYER_PRINCIPAL_REF, and BASELAYER_ALLOWED_ORIGINS on the server.",
    );
  }
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
      throw new Error("BASELAYER_ALLOWED_ORIGINS must contain exact HTTPS origins without paths.");
    }
  }
  return { apiKey, principalRef, allowedOrigins };
}

export interface MintedCredential {
  /** Sensitive: never return this object to an agent, browser UI, or trace. */
  credential: string;
  privateJwk: JsonWebKey;
  audience: string;
  expiresAt: string;
}

/** Mint a new L2 credential and ephemeral presenting key. No identity fields are disclosed. */
export async function mintBaselayerCredential(
  merchant: string,
  options: {
    config?: BaselayerConfig;
    fetch?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<MintedCredential> {
  const config = options.config ?? baselayerConfig();
  let url: URL;
  try {
    url = new URL(merchant);
  } catch {
    throw new Error("The merchant must be an allowed HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !config.allowedOrigins.includes(url.origin)
  ) {
    throw new Error("The merchant is not in BASELAYER_ALLOWED_ORIGINS.");
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const agentKey = publicKey.export({ format: "jwk" });
  const timeout = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)("https://api.baselayer.com/credentials/individual", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({
        principal_ref: config.principalRef,
        level: "L2",
        audience: url.hostname,
        agent_key: agentKey,
      }),
      redirect: "error",
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Baselayer mint request failed. Check connectivity and retry.");
  }
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        "Baselayer could not find this principal in the API key's organization (HTTP 404). Set BASELAYER_PRINCIPAL_REF to a current verified principal from the same sandbox account as BASELAYER_API_KEY.",
      );
    if (response.status === 409)
      throw new Error(
        "Baselayer principal verification is no longer current. Re-verify the demo principal before minting.",
      );
    // Do not propagate API response bodies, which can contain private identity data.
    throw new Error(`Baselayer mint returned HTTP ${response.status}.`);
  }
  try {
    const result = await response.json();
    if (
      typeof result.credential !== "string" ||
      !result.credential.endsWith("~") ||
      result.credential.split("~").length !== 2
    )
      throw new Error();
    const claims = JSON.parse(Buffer.from(result.credential.split(".")[1], "base64url").toString());
    // Preflight only. The merchant must still verify the issuer signature and status.
    if (
      result.audience !== url.hostname ||
      claims.aud !== url.hostname ||
      typeof claims.exp !== "number" ||
      claims.exp <= Date.now() / 1000 + 60 ||
      claims.cnf?.jwk?.kty !== agentKey.kty ||
      claims.cnf?.jwk?.crv !== agentKey.crv ||
      claims.cnf?.jwk?.x !== agentKey.x
    )
      throw new Error();
    return {
      credential: result.credential,
      privateJwk: privateKey.export({ format: "jwk" }),
      audience: url.hostname,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
  } catch {
    throw new Error("Baselayer returned an invalid, expired, or incorrectly bound credential.");
  }
}
