import type { Network } from "#platform/entities.js";
import { vercelWorkspaceTransport } from "#platform/vercel/workspace-transport.js";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";
const VERCEL_CALLBACK_HOST_ENVS = [
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

function readAmbientToken(): string | undefined {
  const requestContext = (
    globalThis as typeof globalThis & {
      [key: symbol]: { get?(): { headers?: Record<string, string> } } | undefined;
    }
  )[VERCEL_REQUEST_CONTEXT];
  const token =
    requestContext?.get?.().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
  const trimmed = token?.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const vercelNetwork = {
  self(urlValue, isTrustedOrigin) {
    if (process.env.VERCEL !== "1") return {};
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      return {};
    }
    const currentHost = VERCEL_CALLBACK_HOST_ENVS.some((name) => {
      const host = process.env[name]?.trim();
      return (
        host !== undefined && host !== "" && URL.parse(`https://${host}`)?.origin === url.origin
      );
    });
    if (url.protocol !== "https:") return {};
    if (!currentHost && !isTrustedOrigin(url)) return {};
    const headers: Record<string, string> = {};
    const token = readAmbientToken();
    if (token !== undefined) headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = token;
    return headers;
  },
  peer: vercelWorkspaceTransport,
  async token() {
    const { getVercelOidcToken } = await import("#compiled/@vercel/oidc/index.js");
    return await getVercelOidcToken();
  },
} satisfies Network;
