/**
 * Everything this app needs to act as a UCP platform: who it says it is,
 * the key it signs with, and a small client for the reads the UI needs.
 *
 * The agent connection (`agent/connections/merchant.ts`) and the checkout
 * route both read from here so the identity on the wire is the same one
 * published at `/.well-known/ucp`.
 */

import {
  createUcpSigner,
  ucpAgentHeaderValue,
  UCP_VERSION,
  type UcpAgentMetadata,
  type UcpSigner,
  type UcpSigningKey,
} from "eve/commerce/ucp";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

/**
 * Public origin of this deployment.
 *
 * Merchants fetch the agent profile from here, so it has to be a host
 * they can reach — a `localhost` dev server is not one. See the README
 * for how to test locally.
 */
export function publicOrigin(): string {
  const configured = process.env.UCP_AGENT_ORIGIN;
  if (configured !== undefined && configured.length > 0) {
    return configured.replace(/\/$/, "");
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel !== undefined && vercel.length > 0) {
    return `https://${vercel}`;
  }
  throw new Error("Set UCP_AGENT_ORIGIN to the public https origin serving /.well-known/ucp.");
}

/** Identity this agent advertises to merchants on every request. */
export function agentMetadata(): UcpAgentMetadata {
  return { profile: `${publicOrigin()}/.well-known/ucp` };
}

/** The merchant's REST endpoint from their `/.well-known/ucp` profile. */
export function merchantEndpoint(): string {
  return required("UCP_MERCHANT_ENDPOINT");
}

/**
 * The signing key, when one is configured.
 *
 * UCP lets a platform authenticate with an API key alone, so signing is
 * optional here; merchants that require signatures answer unsigned
 * requests with `signature_missing`.
 */
export function signingKey(): UcpSigningKey | undefined {
  const jwk = process.env.UCP_SIGNING_KEY_JWK;
  const keyId = process.env.UCP_SIGNING_KEY_ID;
  if (jwk === undefined || jwk.length === 0 || keyId === undefined || keyId.length === 0) {
    return undefined;
  }
  return { keyId, privateKey: JSON.parse(jwk) as Record<string, string> };
}

/**
 * This agent's UCP profile document.
 *
 * The public half of the signing key goes here: it is how a merchant
 * verifies a signature it just received, and the `kid` must match the
 * `keyid` the signer emits.
 */
export function agentProfile(): Record<string, unknown> {
  const key = signingKey();
  const signingKeys: Record<string, unknown>[] = [];
  if (key !== undefined && typeof key.privateKey !== "string") {
    const { d: _private, ...publicJwk } = key.privateKey as Record<string, string>;
    signingKeys.push({ ...publicJwk, alg: "ES256", kid: key.keyId, use: "sig" });
  }

  return {
    signing_keys: signingKeys,
    ucp: {
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
      },
      version: UCP_VERSION,
    },
  };
}

let signer: UcpSigner | undefined;

/**
 * Reads one checkout session straight from the merchant.
 *
 * The agent drives create/update/complete through its connection; the UI
 * reads state here so what it renders comes from the merchant rather than
 * from whatever the browser happens to be holding.
 */
export async function getCheckout(
  id: string,
): Promise<{ status: number; statusText: string; body: unknown }> {
  const url = `${merchantEndpoint()}/checkout-sessions/${encodeURIComponent(id)}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${required("UCP_MERCHANT_TOKEN")}`,
    "Request-Id": crypto.randomUUID(),
    "UCP-Agent": ucpAgentHeaderValue(agentMetadata()),
  };

  const key = signingKey();
  if (key !== undefined) {
    signer ??= createUcpSigner(key);
    Object.assign(headers, await signer({ headers, method: "GET", url }));
  }

  const response = await fetch(url, { headers });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { body, status: response.status, statusText: response.statusText };
}
