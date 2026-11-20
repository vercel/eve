import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import type { PlatformIdentity } from "#platform/types.js";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

export const vercelIdentity: PlatformIdentity = {
  token: () => getVercelOidcToken(),
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
