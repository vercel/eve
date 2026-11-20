import type { PlatformIdentity } from "#platform/types.js";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

export const vercelIdentity: PlatformIdentity = {
  async token() {
    const { getVercelOidcToken } = await import("#compiled/@vercel/oidc/index.js");
    return await getVercelOidcToken();
  },
  ambientToken() {
    const requestContext = (
      globalThis as typeof globalThis & {
        [key: symbol]: { get?(): { headers?: Record<string, string> } } | undefined;
      }
    )[VERCEL_REQUEST_CONTEXT];
    const token =
      requestContext?.get?.().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
    const trimmed = token?.trim();
    return trimmed === "" ? undefined : trimmed;
  },
};
