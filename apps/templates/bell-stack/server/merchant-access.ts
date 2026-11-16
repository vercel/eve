import { createHash, createPrivateKey, sign } from "node:crypto";
import { baselayerConfig, mintBaselayerCredential, type BaselayerConfig } from "./baselayer.js";

export function allowedMerchantUrl(value: string, config = baselayerConfig()): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Use an allowed HTTPS merchant URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !config.allowedOrigins.includes(url.origin)
  ) {
    throw new Error(
      "Merchant access requires an exact allowlisted HTTPS URL without credentials, query, or fragment.",
    );
  }
  return url;
}

export async function prepareMerchantAccess(
  value: string,
  signal: AbortSignal,
  options: {
    config?: BaselayerConfig;
    fetch?: typeof fetch;
    mint?: typeof mintBaselayerCredential;
  } = {},
) {
  const config = options.config ?? baselayerConfig();
  const url = allowedMerchantUrl(value, config);
  const request = async (target: URL, method = "GET") => {
    signal.throwIfAborted();
    try {
      const response = await (options.fetch ?? fetch)(target, {
        method,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      signal.throwIfAborted();
      throw new Error("Merchant credential discovery or nonce request failed.");
    }
  };
  const profile = await request(new URL("/.well-known/kya-profile.json", url));
  const scope = Array.isArray(profile.scopes)
    ? profile.scopes.find(
        (item: { resources?: string[]; accepted_levels?: string[] }) =>
          Array.isArray(item.resources) &&
          item.resources.includes(url.pathname) &&
          Array.isArray(item.accepted_levels) &&
          item.accepted_levels.includes("L2"),
      )
    : undefined;
  if (
    profile.audience !== url.hostname ||
    !scope ||
    typeof scope.id !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(scope.id)
  ) {
    throw new Error("Merchant profile does not advertise this resource with an L2 scope.");
  }
  if (typeof profile.nonce_endpoint !== "string")
    throw new Error("Merchant profile has no nonce endpoint.");
  const nonceUrl = new URL(profile.nonce_endpoint, url.origin);
  if (
    nonceUrl.origin !== url.origin ||
    nonceUrl.username ||
    nonceUrl.password ||
    nonceUrl.hash ||
    nonceUrl.search
  ) {
    throw new Error("Merchant nonce endpoint must stay on the allowed origin.");
  }
  const minted = await (options.mint ?? mintBaselayerCredential)(url.href, {
    config,
    signal,
  });
  const key = createPrivateKey({ key: minted.privateJwk, format: "jwk" });
  return {
    audience: url.hostname,
    scope: scope.id as string,
    expiresAt: minted.expiresAt,
    // Secret-bearing result stays inside the browser adapter, never in tool output.
    async headers(): Promise<Record<string, string>> {
      signal.throwIfAborted();
      if (Date.parse(minted.expiresAt) <= Date.now())
        throw new Error("Minted merchant credential expired.");
      const challenge = await request(nonceUrl, "POST");
      if (
        typeof challenge.nonce !== "string" ||
        !challenge.nonce ||
        challenge.nonce.length > 4096 ||
        (challenge.audience && challenge.audience !== url.hostname)
      )
        throw new Error("Merchant nonce is missing or has the wrong audience.");
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = encode({
        aud: url.hostname,
        nonce: challenge.nonce,
        iat: Math.floor(Date.now() / 1000),
        sd_hash: createHash("sha256").update(minted.credential, "ascii").digest("base64url"),
      });
      const input = `${encode({ alg: "EdDSA", typ: "kb+jwt" })}.${payload}`;
      const proof = `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
      return {
        "KYA-Credential": minted.credential + proof,
        "KYA-Disclosure-Scope": scope.id,
      };
    },
  };
}
